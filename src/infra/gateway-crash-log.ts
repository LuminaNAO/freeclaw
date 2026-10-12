// Gateway crash log (docs/design/gateway-crash-log.md §1).
//
// A run marker `<stateDir>/run/gateway.json` is written when the gateway starts and removed on a
// requested stop/restart. Finding it at the next start means the previous run ended uncleanly:
// one line is appended to `<stateDir>/logs/crashes.jsonl` and one system event is queued for the
// main session once channels are up. Exit hooks write `<stateDir>/run/last-exit.json`
// synchronously so the next start can say why; a hard V8 OOM abort writes nothing, in which case
// the reason is "unknown (no exit record)" and the memory samples (§2) carry the evidence.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { VERSION } from "../version.js";

export const CRASH_REASON_UNKNOWN = "unknown (no exit record)";
const STACK_MAX_LINES = 40;
const CATCHABLE_FATAL_SIGNALS = ["SIGHUP", "SIGQUIT", "SIGABRT"] as const;

export type GatewayRunMarker = { pid: number; startedAt: number; version: string };

export type GatewayExitKind =
  | "uncaughtException"
  | "unhandledRejection"
  | "signal"
  | "near-heap-limit"
  | "exit";

export type GatewayExitRecord = {
  at: number;
  pid: number;
  kind: GatewayExitKind;
  message: string;
  stack?: string;
};

export type GatewayHeapSample = {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
};

export type GatewayCrashEntry = {
  detectedAt: number;
  pid: number;
  startedAt: number;
  uptimeMs: number | null;
  version: string;
  reason: string;
  lastHeap: GatewayHeapSample | null;
};

export function resolveGatewayRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "run");
}

export function resolveGatewayLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "logs");
}

export function resolveRunMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveGatewayRunDir(env), "gateway.json");
}

export function resolveLastExitPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveGatewayRunDir(env), "last-exit.json");
}

export function resolveCrashLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveGatewayLogsDir(env), "crashes.jsonl");
}

export function resolveMemoryLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveGatewayLogsDir(env), "memory.jsonl");
}

function readJsonSync(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJsonSync(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function removeSync(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

export function readRunMarker(env: NodeJS.ProcessEnv = process.env): GatewayRunMarker | null {
  const raw = readJsonSync(resolveRunMarkerPath(env));
  if (!raw || typeof raw.pid !== "number" || typeof raw.startedAt !== "number") {
    return null;
  }
  const version = typeof raw.version === "string" ? raw.version : "unknown";
  return { pid: raw.pid, startedAt: raw.startedAt, version };
}

export function writeRunMarker(
  marker: GatewayRunMarker,
  env: NodeJS.ProcessEnv = process.env,
): void {
  writeJsonSync(resolveRunMarkerPath(env), marker);
}

/** Clean shutdown (stop / restart path): the next start will not report a crash. */
export function removeRunMarker(env: NodeJS.ProcessEnv = process.env): void {
  const marker = readRunMarker(env);
  // Never remove another process's marker (e.g. a respawned child that already started).
  if (marker && marker.pid !== process.pid) {
    return;
  }
  removeSync(resolveRunMarkerPath(env));
  state.cleanExit = true;
}

export function readLastExitRecord(env: NodeJS.ProcessEnv = process.env): GatewayExitRecord | null {
  const raw = readJsonSync(resolveLastExitPath(env));
  if (!raw || typeof raw.kind !== "string") {
    return null;
  }
  return {
    at: typeof raw.at === "number" ? raw.at : 0,
    pid: typeof raw.pid === "number" ? raw.pid : 0,
    kind: raw.kind as GatewayExitKind,
    message: typeof raw.message === "string" ? raw.message : "",
    ...(typeof raw.stack === "string" ? { stack: raw.stack } : {}),
  };
}

function trimStack(stack: string | undefined): string | undefined {
  if (!stack) {
    return undefined;
  }
  return stack.split("\n").slice(0, STACK_MAX_LINES).join("\n");
}

function describeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message || err.name, stack: trimStack(err.stack) };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  try {
    return { message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { message: String(err) };
  }
}

/** Synchronous: safe from `exit`, signal and uncaughtException handlers. */
export function writeLastExitRecord(
  record: Omit<GatewayExitRecord, "at" | "pid"> & { at?: number; pid?: number },
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    writeJsonSync(resolveLastExitPath(env), {
      at: record.at ?? Date.now(),
      pid: record.pid ?? process.pid,
      kind: record.kind,
      message: record.message,
      ...(record.stack ? { stack: trimStack(record.stack) } : {}),
    });
    state.exitRecorded = record.kind !== "near-heap-limit";
  } catch {
    // never let crash bookkeeping throw from a dying process
  }
}

export function clearLastExitRecord(env: NodeJS.ProcessEnv = process.env): void {
  removeSync(resolveLastExitPath(env));
}

/** Last memory sample (§2) written by `pid`, read from the tail of memory.jsonl. */
export function readLastHeapSample(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): GatewayHeapSample | null {
  const file = resolveMemoryLogPath(env);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Partial<GatewayHeapSample> & { pid?: number };
        if (parsed.pid === pid && typeof parsed.heapUsed === "number") {
          return {
            at: Number(parsed.at),
            rss: Number(parsed.rss),
            heapUsed: parsed.heapUsed,
            heapTotal: Number(parsed.heapTotal),
          };
        }
      } catch {
        // first line of the window may be partial
      }
    }
  } catch {
    // no samples yet
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return null;
}

export function appendCrashEntry(
  entry: GatewayCrashEntry,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = resolveCrashLogPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function readCrashEntries(
  opts: { limit?: number; env?: NodeJS.ProcessEnv } = {},
): GatewayCrashEntry[] {
  let raw = "";
  try {
    raw = fs.readFileSync(resolveCrashLogPath(opts.env ?? process.env), "utf8");
  } catch {
    return [];
  }
  const entries: GatewayCrashEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as GatewayCrashEntry);
    } catch {
      // skip a torn line
    }
  }
  const limit = opts.limit;
  return typeof limit === "number" && limit > 0 ? entries.slice(-limit) : entries;
}

function formatReason(record: GatewayExitRecord | null): string {
  if (!record) {
    return CRASH_REASON_UNKNOWN;
  }
  return record.message ? `${record.kind}: ${record.message}` : record.kind;
}

/**
 * §1.1–§1.2: if a run marker is present, the previous run crashed. Append the crash line and
 * return it. Consumes the stale marker and exit record; does not write the new marker.
 */
export function detectPreviousCrash(
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): GatewayCrashEntry | null {
  const env = opts.env ?? process.env;
  const marker = readRunMarker(env);
  if (!marker) {
    // A stray exit record without a marker belongs to a clean run (e.g. a recovered
    // near-heap-limit warning); drop it so it cannot be blamed for a later crash.
    clearLastExitRecord(env);
    return null;
  }
  const now = opts.now ?? Date.now();
  const exitRecord = readLastExitRecord(env);
  const record = exitRecord && exitRecord.pid === marker.pid ? exitRecord : null;
  const lastHeap = readLastHeapSample(marker.pid, env);
  const endedAt = record?.at ?? lastHeap?.at ?? null;
  const entry: GatewayCrashEntry = {
    detectedAt: now,
    pid: marker.pid,
    startedAt: marker.startedAt,
    uptimeMs: endedAt !== null ? Math.max(0, endedAt - marker.startedAt) : null,
    version: marker.version,
    reason: formatReason(record),
    lastHeap,
  };
  appendCrashEntry(entry, env);
  removeSync(resolveRunMarkerPath(env));
  clearLastExitRecord(env);
  return entry;
}

type CrashLogState = {
  hooksInstalled: boolean;
  cleanExit: boolean;
  exitRecorded: boolean;
  pendingRejection: unknown;
  pendingAnnouncement: GatewayCrashEntry | null;
  announced: boolean;
};

const STATE_KEY = Symbol.for("openclaw.gatewayCrashLogState");

function resolveState(): CrashLogState {
  const proc = process as NodeJS.Process & { [STATE_KEY]?: CrashLogState };
  proc[STATE_KEY] ??= {
    hooksInstalled: false,
    cleanExit: false,
    exitRecorded: false,
    pendingRejection: undefined,
    pendingAnnouncement: null,
    announced: false,
  };
  return proc[STATE_KEY];
}

const state = resolveState();

/** Test-only. */
export function resetGatewayCrashLogStateForTest(): void {
  state.cleanExit = false;
  state.exitRecorded = false;
  state.pendingRejection = undefined;
  state.pendingAnnouncement = null;
  state.announced = false;
}

type HookTarget = Pick<
  NodeJS.Process,
  "prependListener" | "on" | "removeListener" | "listenerCount" | "kill" | "pid"
>;

/** Exported for tests (with a fake process); production calls it via beginGatewayRun. */
export function installExitHooks(env: NodeJS.ProcessEnv, proc: HookTarget = process): void {
  if (proc === process) {
    if (state.hooksInstalled) {
      return;
    }
    state.hooksInstalled = true;
  }
  // Prepended so they run before the CLI handlers that call process.exit().
  proc.prependListener("uncaughtException", (err: unknown) => {
    writeLastExitRecord({ kind: "uncaughtException", ...describeError(err) }, env);
  });
  proc.prependListener("unhandledRejection", (reason: unknown) => {
    // Most rejections are logged and survived; only record one if the process exits while
    // handling it (the CLI handler calls process.exit synchronously in the same dispatch).
    state.pendingRejection = reason;
    setImmediate(() => {
      if (state.pendingRejection === reason) {
        state.pendingRejection = undefined;
      }
    }).unref?.();
  });
  proc.on("exit", (code: number) => {
    if (state.cleanExit || state.exitRecorded || code === 0) {
      return;
    }
    if (state.pendingRejection !== undefined) {
      writeLastExitRecord(
        { kind: "unhandledRejection", ...describeError(state.pendingRejection) },
        env,
      );
      return;
    }
    writeLastExitRecord({ kind: "exit", message: `exit code ${code}` }, env);
  });
  for (const signal of CATCHABLE_FATAL_SIGNALS) {
    const handler = () => {
      writeLastExitRecord({ kind: "signal", message: signal }, env);
      proc.removeListener(signal, handler);
      // Keep the default fatal behaviour when nobody else handles this signal.
      if (proc.listenerCount(signal) === 0) {
        try {
          proc.kill(proc.pid, signal);
        } catch {
          // ignore
        }
      }
    };
    try {
      proc.prependListener(signal, handler);
    } catch {
      // unsupported on this platform
    }
  }
}

/**
 * Called once the gateway lock is held: detect a crashed predecessor, write this run's marker,
 * install exit hooks. Safe to call again on an in-process restart (same pid → no crash).
 */
export function beginGatewayRun(
  opts: { env?: NodeJS.ProcessEnv; now?: number; installHooks?: boolean } = {},
): GatewayCrashEntry | null {
  const env = opts.env ?? process.env;
  const existing = readRunMarker(env);
  let crash: GatewayCrashEntry | null = null;
  if (!existing || existing.pid !== process.pid) {
    crash = detectPreviousCrash({ env, now: opts.now });
    writeRunMarker({ pid: process.pid, startedAt: opts.now ?? Date.now(), version: VERSION }, env);
  }
  state.cleanExit = false;
  if (opts.installHooks !== false) {
    installExitHooks(env);
  }
  if (crash && !state.announced) {
    state.pendingAnnouncement = crash;
  }
  return crash;
}

export function formatCrashAnnouncement(entry: GatewayCrashEntry): string {
  const uptime =
    entry.uptimeMs !== null ? `${(entry.uptimeMs / 3_600_000).toFixed(1)}h` : "unknown";
  const heap = entry.lastHeap
    ? `${(entry.lastHeap.heapUsed / 1024 ** 3).toFixed(2)} GB`
    : "unknown";
  return `Gateway restarted after crash: ${entry.reason}, uptime ${uptime}, heap ${heap} at last sample`;
}

/** §1.4: returns the announcement text exactly once per process, then null. */
export function takeCrashAnnouncement(): string | null {
  if (state.announced || !state.pendingAnnouncement) {
    return null;
  }
  state.announced = true;
  const text = formatCrashAnnouncement(state.pendingAnnouncement);
  state.pendingAnnouncement = null;
  return text;
}
