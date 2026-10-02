import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real client, daemon spawn, socket-dir and socket client; only the reply pipeline, pairing
// store and config loading are stubbed. The "signal-cli" is a Node script that binds the
// --socket path and speaks newline JSON-RPC, so no real Signal account is involved.

const replyMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn());
let config: Record<string, unknown> = {};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => config, writeConfigFile: writeConfigFileMock };
});
vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
}));
vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "X", created: true }),
}));
vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
  updateLastRoute: vi.fn(),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

const { monitorSignalProvider } = await import("./monitor.js");

const FAKE_SIGNAL_CLI = String.raw`#!/usr/bin/env node
const net = require("net");
const fs = require("fs");
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv));
const sockPath = argv[argv.indexOf("--socket") + 1];
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG_FILE, JSON.stringify(o) + "\n");
const server = net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const req = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      log({ method: req.method, params: req.params });
      const send = (o) => c.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
      if (req.method === "subscribeReceive") {
        send({ result: 0, id: req.id });
        send({ method: "receive", params: { subscription: 0, result: {
          account: "+15550001111",
          envelope: { sourceNumber: "+15550002222", sourceName: "Ada", timestamp: 1,
            dataMessage: { message: "hello over the socket" } } } } });
      } else if (req.method === "send") {
        send({ result: { timestamp: 42 }, id: req.id });
      } else {
        send({ result: {}, id: req.id });
      }
    }
  });
  c.on("error", () => {});
});
server.listen(sockPath);
process.on("SIGTERM", () => { server.close(); try { fs.unlinkSync(sockPath); } catch {} process.exit(0); });
`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
      } else {
        setTimeout(tick, 20);
      }
    };
    tick();
  });
}

describe("signal monitor over a real unix socket (fake signal-cli)", () => {
  it("spawns --socket in a 0700 dir, receives, replies, enforces 0600, and cleans up", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sige2e-"));
    roots.push(root);
    fs.chmodSync(root, 0o700);
    const cli = path.join(root, "signal-cli");
    fs.writeFileSync(cli, FAKE_SIGNAL_CLI, { mode: 0o755 });
    const argvFile = path.join(root, "argv.json");
    const logFile = path.join(root, "rpc.log");
    fs.writeFileSync(logFile, "");
    process.env.FAKE_ARGV_FILE = argvFile;
    process.env.FAKE_LOG_FILE = logFile;
    const sockDir = path.join(root, "sockets");
    const socketPath = path.join(sockDir, "default.sock");
    // A stale socket from a "crashed" daemon must be removed, not block startup.
    fs.mkdirSync(sockDir, { mode: 0o755 });

    config = {
      messages: {},
      channels: {
        signal: {
          account: "+15550001111",
          cliPath: cli,
          socketPath,
          httpPort: 56123,
          dmPolicy: "open",
          allowFrom: ["*"],
          startupTimeoutMs: 15_000,
        },
      },
    };
    replyMock.mockResolvedValue({ text: "reply over the socket" });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never };
    const abort = new AbortController();
    const done = monitorSignalProvider({ abortSignal: abort.signal, runtime: runtime as never });

    const rpcLog = () =>
      fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; params?: Record<string, unknown> });
    await waitFor(() => rpcLog().some((e) => e.method === "send"));

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
    expect(argv).toContain("--socket");
    expect(argv).not.toContain("--http");
    expect(argv).not.toContain("--tcp");
    expect(argv.slice(argv.indexOf("--receive-mode"), argv.indexOf("--receive-mode") + 2)).toEqual([
      "--receive-mode",
      "manual",
    ]);
    expect(fs.lstatSync(sockDir).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(socketPath).mode & 0o777).toBe(0o600);
    const send = rpcLog().find((e) => e.method === "send");
    expect(send?.params).toMatchObject({ message: "reply over the socket" });
    expect(rpcLog().some((e) => e.method === "receive")).toBe(false);
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("no authentication"));
    // Socket mode never persists an HTTP port, even with a saved httpPort in config.
    expect(writeConfigFileMock).not.toHaveBeenCalled();

    abort.abort();
    await done;
    await waitFor(() => !fs.existsSync(socketPath));
  }, 30_000);
});
