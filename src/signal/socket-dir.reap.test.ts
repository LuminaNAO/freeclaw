import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSignalOwnerPath, writeSignalOwnerRecord } from "./daemon-owner.js";
import {
  parseProcNetUnixInodes,
  parseProcStat,
  type ProcStat,
  type ProcTable,
} from "./proc-table.js";
import { clearStaleSignalSocket, SignalSocketBusyError } from "./socket-dir.js";

// signal-daemon-lifecycle ARCH §3.3 / §4: adopt-or-reap on start. The process table is fake,
// so nothing real is ever signalled; the "daemon" holding the socket is an in-test server.

const uid = process.getuid?.() ?? 1000;
const ACCOUNT = "+15550001111";
const ORPHAN_PID = 424242;
const START = "998877";

type FakeProc = {
  stat: ProcStat;
  cmdline: string[];
  uid: number;
  /** What happens when a signal arrives; default: exit on SIGTERM and SIGKILL. */
  onSignal?: (signal: NodeJS.Signals) => "exit" | "ignore";
};

function fakeProcTable(
  procs: Map<number, FakeProc>,
  opts: { onExit?: (pid: number) => void; holders?: number[] | null } = {},
) {
  const kills: Array<[number, NodeJS.Signals]> = [];
  const table: ProcTable = {
    readStat: (pid) => procs.get(pid)?.stat ?? null,
    readCmdline: (pid) => procs.get(pid)?.cmdline ?? null,
    readUid: (pid) => procs.get(pid)?.uid ?? null,
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      const p = procs.get(pid);
      if (!p) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if ((p.onSignal?.(signal) ?? "exit") === "exit" || signal === "SIGKILL") {
        procs.delete(pid);
        opts.onExit?.(pid);
      }
    },
    findSocketHolders: () => (opts.holders === undefined ? [] : opts.holders),
  };
  return { table, kills };
}

const roots: string[] = [];
const servers: net.Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
    }
  }
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => s.close(() => resolve(undefined)));
  }
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

async function liveSocket(): Promise<{ socketPath: string; server: net.Server; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigreap-"));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const socketPath = path.join(root, "default.sock");
  const server = net.createServer((c) => c.on("error", () => {}));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  servers.push(server);
  return { socketPath, server, root };
}

async function stopServer(server: net.Server): Promise<void> {
  const i = servers.indexOf(server);
  if (i >= 0) {
    servers.splice(i, 1);
  }
  await new Promise((resolve) => server.close(() => resolve(undefined)));
}

/** A stub listener in a child process this test spawned; SIGKILL leaves its socket inode. */
async function stubHolder(socketPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.on("SIGTERM", () => {}); require("net").createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write("up"))`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(child);
  await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
  return child;
}

function orphanProc(socketPath: string, overrides: Partial<FakeProc> = {}): FakeProc {
  return {
    stat: { state: "S", ppid: 1, startTime: START },
    cmdline: [
      "/usr/lib/jvm/bin/java",
      "-classpath",
      "/opt/signal-cli/lib/signal-cli.jar",
      "org.asamk.signal.Main",
      "-a",
      ACCOUNT,
      "daemon",
      "--socket",
      socketPath,
      "--no-receive-stdout",
    ],
    uid,
    ...overrides,
  };
}

function writeOwner(socketPath: string, overrides: Record<string, unknown> = {}) {
  writeSignalOwnerRecord({
    pid: ORPHAN_PID,
    startTime: START,
    account: ACCOUNT,
    socketPath,
    gatewayPid: 31337,
    stateDir: "/state",
    cliPath: "/opt/signal-cli/bin/signal-cli",
    ...overrides,
  } as never);
}

function fastDeps(table: ProcTable, log = vi.fn()) {
  let now = 0;
  return {
    log,
    proc: table,
    getuid: () => uid,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    reapGraceMs: 10_000,
    pollMs: 100,
    elapsed: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("clearStaleSignalSocket adopt-or-reap (ARCH §3.3)", () => {
  it("our orphan: SIGTERM, wait, socket and owner file cleared, one reap log line", async () => {
    const { socketPath, server } = await liveSocket();
    writeOwner(socketPath);
    const procs = new Map([[ORPHAN_PID, orphanProc(socketPath)]]);
    const { table, kills } = fakeProcTable(procs, { onExit: () => void stopServer(server) });
    const deps = fastDeps(table);
    const result = await clearStaleSignalSocket({
      socketPath,
      accountId: "default",
      account: ACCOUNT,
      deps,
    });
    expect(result).toEqual({ reaped: { pid: ORPHAN_PID, gatewayPid: 31337 } });
    expect(kills).toEqual([[ORPHAN_PID, "SIGTERM"]]);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(resolveSignalOwnerPath(socketPath))).toBe(false);
    expect(deps.log.mock.calls.map((c) => c[0])).toEqual([
      `signal: reaped orphaned signal-cli pid ${ORPHAN_PID} (previous gateway 31337)`,
    ]);
  });

  it("orphan ignores SIGTERM: SIGKILL after the 10 s grace, leftover socket removed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigreap-"));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, "default.sock");
    const holder = await stubHolder(socketPath);
    writeOwner(socketPath);
    const procs = new Map([
      [
        ORPHAN_PID,
        orphanProc(socketPath, {
          onSignal: (s) => {
            // The fake table maps the fake orphan onto the stub child this test owns.
            holder.kill(s);
            return s === "SIGKILL" ? "exit" : "ignore";
          },
        }),
      ],
    ]);
    const { table, kills } = fakeProcTable(procs);
    const deps = fastDeps(table);
    deps.sleep = async (ms: number) => {
      deps.advance(ms);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const result = await clearStaleSignalSocket({
      socketPath,
      accountId: "default",
      account: ACCOUNT,
      deps,
    });
    expect(result?.reaped.pid).toBe(ORPHAN_PID);
    expect(kills).toEqual([
      [ORPHAN_PID, "SIGTERM"],
      [ORPHAN_PID, "SIGKILL"],
    ]);
    expect(deps.elapsed()).toBeGreaterThanOrEqual(10_000);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(resolveSignalOwnerPath(socketPath))).toBe(false);
  });

  const refusals: Array<[string, (socketPath: string) => FakeProc, Record<string, unknown>?]> = [
    [
      "pid reused by another program (start time differs)",
      (p) => orphanProc(p, { stat: { state: "S", ppid: 1, startTime: "1" } }),
    ],
    [
      "pid reused by another program (cmdline is not signal-cli)",
      () => ({ ...orphanProc(""), cmdline: ["/usr/bin/python3", "server.py"] }),
    ],
    ["different uid", (p) => orphanProc(p, { uid: uid + 1 })],
    ["different account in the owner record", (p) => orphanProc(p), { account: "+15559999999" }],
    [
      "process serves a different account",
      (p) => ({
        ...orphanProc(p),
        cmdline: orphanProc(p).cmdline.map((a) => (a === ACCOUNT ? "+15559999999" : a)),
      }),
    ],
    [
      "still the child of a live gateway",
      (p) => orphanProc(p, { stat: { state: "S", ppid: 31337, startTime: START } }),
    ],
    ["a zombie", (p) => orphanProc(p, { stat: { state: "Z", ppid: 1, startTime: START } })],
  ];

  it.each(refusals)("owner present but %s: refused, not killed", async (_l, mk, ownerOverrides) => {
    const { socketPath } = await liveSocket();
    writeOwner(socketPath, ownerOverrides);
    const procs = new Map([[ORPHAN_PID, mk(socketPath)]]);
    const { table, kills } = fakeProcTable(procs);
    await expect(
      clearStaleSignalSocket({
        socketPath,
        accountId: "default",
        account: ACCOUNT,
        deps: fastDeps(table),
      }),
    ).rejects.toThrow(SignalSocketBusyError);
    expect(kills).toEqual([]);
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(fs.existsSync(resolveSignalOwnerPath(socketPath))).toBe(true);
  });

  it("refuses an owner file that is group/other readable or not ours", async () => {
    const { socketPath } = await liveSocket();
    writeOwner(socketPath);
    fs.chmodSync(resolveSignalOwnerPath(socketPath), 0o644);
    const { table, kills } = fakeProcTable(new Map([[ORPHAN_PID, orphanProc(socketPath)]]));
    await expect(
      clearStaleSignalSocket({
        socketPath,
        accountId: "default",
        account: ACCOUNT,
        deps: fastDeps(table),
      }),
    ).rejects.toThrow(/accessible by group\/other/);
    fs.chmodSync(resolveSignalOwnerPath(socketPath), 0o600);
    await expect(
      clearStaleSignalSocket({
        socketPath,
        accountId: "default",
        account: ACCOUNT,
        deps: { ...fastDeps(table), getuid: () => uid + 7 },
      }),
    ).rejects.toThrow(/owned by uid/);
    expect(kills).toEqual([]);
  });

  it("no owner file + live socket: refused, message names holder pid, uid, cmdline and a command", async () => {
    const { socketPath } = await liveSocket();
    const holder = 5150;
    const procs = new Map([
      [
        holder,
        orphanProc(socketPath, {
          uid: 1234,
          cmdline: ["signal-cli", "daemon", "--socket", socketPath],
        }),
      ],
    ]);
    const { table, kills } = fakeProcTable(procs, { holders: [holder] });
    const err = await clearStaleSignalSocket({
      socketPath,
      accountId: "acct1",
      account: ACCOUNT,
      deps: fastDeps(table),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignalSocketBusyError);
    const message = (err as Error).message;
    expect(message).toMatch(/another signal-cli is serving .* account acct1/);
    expect(message).toContain("no owner record");
    expect(message).toContain(`pid ${holder} uid 1234: signal-cli daemon --socket ${socketPath}`);
    expect(message).toContain(`kill ${holder}`);
    expect(kills).toEqual([]);
  });

  it("no visible holder: still refused, with a lookup hint", async () => {
    const { socketPath } = await liveSocket();
    const { table } = fakeProcTable(new Map(), { holders: [] });
    await expect(
      clearStaleSignalSocket({
        socketPath,
        accountId: "default",
        account: ACCOUNT,
        deps: fastDeps(table),
      }),
    ).rejects.toThrow(/no visible holder.*ss -xlp/);
  });

  it("without a process table (non-Linux) keeps today's plain refusal", async () => {
    const { socketPath } = await liveSocket();
    writeOwner(socketPath);
    await expect(clearStaleSignalSocket({ socketPath, accountId: "acct1" })).rejects.toThrow(
      /another signal-cli is serving .* account acct1/,
    );
  });

  it("a stale socket removes the leftover owner file too", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sigreap-"));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const socketPath = path.join(root, "default.sock");
    const holder = await stubHolder(socketPath);
    writeOwner(socketPath);
    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    await clearStaleSignalSocket({ socketPath, accountId: "default", account: ACCOUNT });
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(resolveSignalOwnerPath(socketPath))).toBe(false);
  });
});

describe("proc parsing", () => {
  it("parses /proc/<pid>/stat with spaces and parens in comm", () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 4));
    fields[0] = "S"; // state (field 3)
    fields[1] = "77"; // ppid (field 4)
    fields[19] = "123456"; // starttime (field 22)
    expect(parseProcStat(`42 (java (x) y) ${fields.join(" ")}`)).toEqual({
      state: "S",
      ppid: 77,
      startTime: "123456",
    });
    expect(parseProcStat("garbage")).toBeNull();
  });

  it("finds inodes for a socket path in /proc/net/unix", () => {
    const raw = [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      "0000000000000000: 00000002 00000000 00010000 0001 01 37979 /run/a.sock",
      "0000000000000000: 00000002 00000000 00010000 0001 01 40001 /tmp/with space.sock",
      "0000000000000000: 00000003 00000000 00000000 0001 03 163689965",
    ].join("\n");
    expect(parseProcNetUnixInodes(raw, "/run/a.sock")).toEqual(["37979"]);
    expect(parseProcNetUnixInodes(raw, "/tmp/with space.sock")).toEqual(["40001"]);
    expect(parseProcNetUnixInodes(raw, "/nope")).toEqual([]);
  });
});
