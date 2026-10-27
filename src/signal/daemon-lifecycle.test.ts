import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSignalOwnerRecord, resolveSignalOwnerPath } from "./daemon-owner.js";
import {
  buildSignalDaemonSpawnCommand,
  resolvePdeathsigWrapper,
  spawnSignalDaemon,
  type SignalDaemonHandle,
} from "./daemon.js";
import { createLinuxProcTable, isProcAlive } from "./proc-table.js";

// signal-daemon-lifecycle ARCH §4: owner record + die-with-parent. Every process here is a
// stub this test spawned (a Node script standing in for signal-cli); no real signal-cli is
// started or signalled.

const isLinux = process.platform === "linux";
const repoRoot = path.resolve(import.meta.dirname, "../..");
const uid = process.getuid?.() ?? 0;
const proc = createLinuxProcTable();

const STUB_CLI = String.raw`
const net = require("net");
const fs = require("fs");
const argv = process.argv.slice(2);
const sockPath = argv[argv.indexOf("--socket") + 1];
const server = net.createServer((c) => c.on("error", () => {}));
server.listen(sockPath, () => process.stdout.write("up\n"));
process.on("SIGTERM", () => { server.close(); try { fs.unlinkSync(sockPath); } catch {} process.exit(0); });
setInterval(() => {}, 1000);
`;

const roots: string[] = [];
const handles: SignalDaemonHandle[] = [];
const stubPids: Array<{ pid: number; startTime?: string; marker: string }> = [];
const parents: ChildProcess[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sigown-"));
  fs.chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function writeStubCli(root: string): string {
  const cli = path.join(root, "signal-cli");
  fs.writeFileSync(cli, `#!${process.execPath}\n${STUB_CLI}`, { mode: 0o700 });
  return cli;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  for (const h of handles.splice(0)) {
    h.stop();
    await Promise.race([h.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  for (const p of parents.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) {
      p.kill("SIGKILL");
    }
  }
  // Safety net: only ever signal a stub we started, verified by start time and cmdline.
  for (const stub of stubPids.splice(0)) {
    const cmd = proc.readCmdline(stub.pid)?.join(" ") ?? "";
    if (isProcAlive(proc, stub.pid, stub.startTime) && cmd.includes(stub.marker)) {
      process.kill(stub.pid, "SIGKILL");
    }
  }
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

describe("buildSignalDaemonSpawnCommand (ARCH §3.2)", () => {
  it("wraps signal-cli in setpriv --pdeathsig SIGTERM when a wrapper is available", () => {
    const opts = {
      cliPath: "/opt/signal-cli/bin/signal-cli",
      account: "+15550001111",
      listener: { kind: "socket" as const, path: "/run/x/default.sock" },
    };
    expect(buildSignalDaemonSpawnCommand(opts, "/usr/bin/setpriv")).toEqual({
      command: "/usr/bin/setpriv",
      args: [
        "--pdeathsig",
        "SIGTERM",
        "--",
        "/opt/signal-cli/bin/signal-cli",
        "-a",
        "+15550001111",
        "daemon",
        "--socket",
        "/run/x/default.sock",
        "--no-receive-stdout",
      ],
    });
    expect(buildSignalDaemonSpawnCommand(opts, null).command).toBe(
      "/opt/signal-cli/bin/signal-cli",
    );
  });
});

describe.runIf(isLinux)("owner record (ARCH §3.1)", () => {
  it.each([
    ["with the pdeathsig wrapper", resolvePdeathsigWrapper()],
    ["without a wrapper", null],
  ] as const)(
    "is written on spawn (0600, atomic) and removed on clean exit %s",
    async (_label, wrapper) => {
      const root = tmpRoot();
      const cli = writeStubCli(root);
      const socketPath = path.join(root, "default.sock");
      const handle = spawnSignalDaemon({
        cliPath: cli,
        account: "+15550001111",
        listener: { kind: "socket", path: socketPath },
        pdeathsigWrapper: wrapper,
        stateDir: root,
      });
      handles.push(handle);
      const pid = handle.pid as number;
      stubPids.push({ pid, startTime: proc.readStat(pid)?.startTime, marker: cli });
      const ownerPath = resolveSignalOwnerPath(socketPath);
      expect(fs.lstatSync(ownerPath).mode & 0o777).toBe(0o600);
      // Atomic: no temp file is left beside the record.
      expect(fs.readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      const read = readSignalOwnerRecord(socketPath, uid);
      expect(read.kind).toBe("ok");
      if (read.kind !== "ok") {
        return;
      }
      expect(read.record).toEqual({
        pid,
        startTime: proc.readStat(pid)?.startTime,
        account: "+15550001111",
        socketPath,
        gatewayPid: process.pid,
        stateDir: root,
        cliPath: cli,
      });
      await waitFor(() => fs.existsSync(socketPath));
      // Same pid as the daemon: setpriv execs signal-cli, so the record names the daemon.
      expect(proc.readCmdline(pid)?.join(" ")).toContain(cli);

      handle.stop();
      await handle.exited;
      expect(fs.existsSync(ownerPath)).toBe(false);
    },
  );
});

/**
 * Stand-in gateway: a separate Node process that spawns the stub daemon through the real
 * spawnSignalDaemon, prints the daemon pid, then waits for the test to end it.
 */
function startStubGateway(params: {
  cli: string;
  socketPath: string;
  wrapper: string | null;
  exitAfterSpawn?: boolean;
}): { parent: ChildProcess; daemonPid: Promise<number> } {
  const script = `
    const { spawnSignalDaemon } = await import(${JSON.stringify(path.join(repoRoot, "src/signal/daemon.ts"))});
    const h = spawnSignalDaemon({
      cliPath: ${JSON.stringify(params.cli)},
      account: "+15550001111",
      listener: { kind: "socket", path: ${JSON.stringify(params.socketPath)} },
      pdeathsigWrapper: ${JSON.stringify(params.wrapper)},
    });
    process.stdout.write("pid " + h.pid + "\\n");
    ${params.exitAfterSpawn ? "setTimeout(() => process.exit(0), 300);" : "setInterval(() => {}, 1000);"}
  `;
  const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });
  parents.push(parent);
  const daemonPid = new Promise<number>((resolve, reject) => {
    let buf = "";
    parent.stdout?.on("data", (d) => {
      buf += String(d);
      const m = /pid (\d+)/.exec(buf);
      if (m) {
        resolve(Number(m[1]));
      }
    });
    parent.once("exit", () => reject(new Error(`stub gateway exited early: ${buf}`)));
  });
  return { parent, daemonPid };
}

describe.runIf(isLinux)("gateway shutdown stops the daemon (ARCH §3.2, integration)", () => {
  const wrapper = resolvePdeathsigWrapper();

  it.runIf(wrapper !== null)(
    "a hard SIGKILL of the gateway takes the daemon down via pdeathsig",
    async () => {
      const root = tmpRoot();
      const cli = writeStubCli(root);
      const socketPath = path.join(root, "default.sock");
      const { parent, daemonPid } = startStubGateway({ cli, socketPath, wrapper });
      const pid = await daemonPid;
      const startTime = proc.readStat(pid)?.startTime;
      stubPids.push({ pid, startTime, marker: cli });
      await waitFor(() => fs.existsSync(socketPath));
      expect(isProcAlive(proc, pid, startTime)).toBe(true);

      parent.kill("SIGKILL"); // the stub gateway we spawned; no exit handlers can run
      await waitFor(() => !isProcAlive(proc, pid, startTime));
      // The daemon got SIGTERM (not SIGKILL), so it cleaned its socket up itself.
      await waitFor(() => !fs.existsSync(socketPath));
    },
    20_000,
  );

  it("a gateway exit without pdeathsig stops the daemon through the exit hook", async () => {
    const root = tmpRoot();
    const cli = writeStubCli(root);
    const socketPath = path.join(root, "default.sock");
    const { daemonPid } = startStubGateway({
      cli,
      socketPath,
      wrapper: null,
      exitAfterSpawn: true,
    });
    const pid = await daemonPid;
    const startTime = proc.readStat(pid)?.startTime;
    stubPids.push({ pid, startTime, marker: cli });
    await waitFor(() => !isProcAlive(proc, pid, startTime));
  }, 20_000);
});
