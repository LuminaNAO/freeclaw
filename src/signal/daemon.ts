import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { resolveStateDir } from "../config/paths.js";
import type { RuntimeEnv } from "../runtime.js";
import { removeSignalOwnerRecord, writeSignalOwnerRecord } from "./daemon-owner.js";
import { createLinuxProcTable, type ProcTable } from "./proc-table.js";

export type SignalDaemonListener =
  | { kind: "socket"; path: string }
  | { kind: "http"; host: string; port: number };

export type SignalDaemonOpts = {
  cliPath: string;
  account?: string;
  /** Exactly one listener; socket mode can never also open a TCP port. */
  listener: SignalDaemonListener;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  runtime?: RuntimeEnv;
  /** Test seams; production uses the real platform, PATH lookup and /proc. */
  platform?: NodeJS.Platform;
  /** Absolute setpriv path, or null to disable the pdeathsig wrapper. */
  pdeathsigWrapper?: string | null;
  proc?: ProcTable;
  stateDir?: string;
};

export type SignalDaemonHandle = {
  pid?: number;
  stop: () => void;
  exited: Promise<SignalDaemonExitEvent>;
  isExited: () => boolean;
};

export type SignalDaemonExitEvent = {
  source: "process" | "spawn-error";
  code: number | null;
  signal: NodeJS.Signals | null;
};

export function formatSignalDaemonExit(exit: SignalDaemonExitEvent): string {
  return `signal daemon exited (source=${exit.source} code=${String(exit.code ?? "null")} signal=${exit.signal ?? "null"})`;
}

export function classifySignalCliLogLine(line: string): "log" | "error" | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  // signal-cli commonly writes all logs to stderr; treat severity explicitly.
  if (/\b(ERROR|WARN|WARNING)\b/.test(trimmed)) {
    return "error";
  }
  // Some signal-cli failures are not tagged with WARN/ERROR but should still be surfaced loudly.
  if (/\b(FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) {
    return "error";
  }
  return "log";
}

function bindSignalCliOutput(params: {
  stream: NodeJS.ReadableStream | null | undefined;
  log: (message: string) => void;
  error: (message: string) => void;
}): void {
  params.stream?.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifySignalCliLogLine(line);
      if (kind === "log") {
        params.log(`signal-cli: ${line.trim()}`);
      } else if (kind === "error") {
        params.error(`signal-cli: ${line.trim()}`);
      }
    }
  });
}

export function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];
  if (opts.account) {
    args.push("-a", opts.account);
  }
  args.push("daemon");
  if (opts.listener.kind === "socket") {
    args.push("--socket", opts.listener.path);
  } else {
    args.push("--http", `${opts.listener.host}:${opts.listener.port}`);
  }
  args.push("--no-receive-stdout");

  if (opts.receiveMode) {
    args.push("--receive-mode", opts.receiveMode);
  }
  if (opts.ignoreAttachments) {
    args.push("--ignore-attachments");
  }
  if (opts.ignoreStories) {
    args.push("--ignore-stories");
  }
  if (opts.sendReadReceipts) {
    args.push("--send-read-receipts");
  }

  return args;
}

const SETPRIV_CANDIDATES = [
  "/usr/bin/setpriv",
  "/bin/setpriv",
  "/usr/sbin/setpriv",
  "/sbin/setpriv",
];
let cachedSetpriv: string | null | undefined;

/**
 * signal-daemon-lifecycle ARCH §3.2: on Linux the daemon is started through util-linux
 * `setpriv --pdeathsig SIGTERM`, which sets PR_SET_PDEATHSIG and then execs signal-cli
 * (same pid; the setting survives exec), so the kernel stops the daemon when the gateway
 * dies, including SIGKILL/OOM. No native module needed. Returns null when setpriv is
 * missing or too old to know --pdeathsig; the exit hooks plus the §3.3 reap cover that case.
 */
export function resolvePdeathsigWrapper(): string | null {
  if (cachedSetpriv !== undefined) {
    return cachedSetpriv;
  }
  cachedSetpriv = null;
  for (const candidate of SETPRIV_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    try {
      const help = execFileSync(candidate, ["--help"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (help.includes("--pdeathsig")) {
        cachedSetpriv = candidate;
      }
    } catch {
      // unusable; try the next candidate
    }
    break;
  }
  return cachedSetpriv;
}

export function buildSignalDaemonSpawnCommand(
  opts: SignalDaemonOpts,
  wrapper: string | null,
): { command: string; args: string[] } {
  const args = buildDaemonArgs(opts);
  if (wrapper) {
    return { command: wrapper, args: ["--pdeathsig", "SIGTERM", "--", opts.cliPath, ...args] };
  }
  return { command: opts.cliPath, args };
}

const liveChildren = new Set<{ kill: (signal: NodeJS.Signals) => void }>();
let exitHookInstalled = false;

/**
 * ARCH §3.2 fallback for every platform: on process exit (normal exit, uncaught exception,
 * the gateway's own SIGTERM/SIGINT handlers ending in process.exit) stop any daemon still
 * running. Hard kills skip this; pdeathsig (Linux) and the §3.3 reap cover those.
 */
function trackChildForExit(entry: { kill: (signal: NodeJS.Signals) => void }): () => void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const child of liveChildren) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    });
  }
  liveChildren.add(entry);
  return () => {
    liveChildren.delete(entry);
  };
}

export function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle {
  const platform = opts.platform ?? process.platform;
  const wrapper =
    platform === "linux"
      ? opts.pdeathsigWrapper !== undefined
        ? opts.pdeathsigWrapper
        : resolvePdeathsigWrapper()
      : null;
  const { command, args } = buildSignalDaemonSpawnCommand(opts, wrapper);
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = opts.runtime?.log ?? (() => {});
  const error = opts.runtime?.error ?? (() => {});
  let exited = false;
  let settledExit = false;
  let resolveExit!: (value: SignalDaemonExitEvent) => void;
  const exitedPromise = new Promise<SignalDaemonExitEvent>((resolve) => {
    resolveExit = resolve;
  });
  const settleExit = (value: SignalDaemonExitEvent) => {
    if (settledExit) {
      return;
    }
    settledExit = true;
    exited = true;
    resolveExit(value);
  };

  const untrack = trackChildForExit({ kill: (signal) => child.kill(signal) });
  const socketPath = opts.listener.kind === "socket" ? opts.listener.path : undefined;
  const childPid = child.pid;
  let ownerWritten = false;
  // ARCH §3.1: record ownership so the next gateway can tell our orphan from a stranger.
  if (socketPath && childPid && platform === "linux") {
    const startTime = (opts.proc ?? createLinuxProcTable()).readStat(childPid)?.startTime;
    if (startTime) {
      try {
        writeSignalOwnerRecord({
          pid: childPid,
          startTime,
          account: opts.account,
          socketPath,
          gatewayPid: process.pid,
          stateDir: opts.stateDir ?? resolveStateDir(process.env),
          cliPath: opts.cliPath,
        });
        ownerWritten = true;
      } catch (err) {
        error(`signal: cannot write daemon owner record for ${socketPath}: ${String(err)}`);
      }
    } else {
      error(`signal: cannot read start time of signal-cli pid ${childPid}; no owner record`);
    }
  }
  const onGone = () => {
    untrack();
    if (ownerWritten && socketPath) {
      ownerWritten = false;
      removeSignalOwnerRecord(socketPath, childPid);
    }
  };

  bindSignalCliOutput({ stream: child.stdout, log, error });
  bindSignalCliOutput({ stream: child.stderr, log, error });
  child.once("exit", (code, signal) => {
    onGone();
    settleExit({
      source: "process",
      code: typeof code === "number" ? code : null,
      signal: signal ?? null,
    });
    error(
      formatSignalDaemonExit({ source: "process", code: code ?? null, signal: signal ?? null }),
    );
  });
  child.once("close", (code, signal) => {
    settleExit({
      source: "process",
      code: typeof code === "number" ? code : null,
      signal: signal ?? null,
    });
  });
  child.on("error", (err) => {
    error(`signal-cli spawn error: ${String(err)}`);
    onGone();
    settleExit({ source: "spawn-error", code: null, signal: null });
  });

  return {
    pid: child.pid ?? undefined,
    exited: exitedPromise,
    isExited: () => exited,
    stop: () => {
      if (!child.killed && !exited) {
        child.kill("SIGTERM");
      }
    },
  };
}
