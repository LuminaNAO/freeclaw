// Gateway memory evidence (docs/design/gateway-crash-log.md §2, §3).
//
// §2: every 60 s append one sample to `<stateDir>/logs/memory.jsonl`, keeping the file under
// 20 MB by dropping the oldest half. §3: heap snapshots on request (gateway RPC) and one automatic
// snapshot per process when heapUsed crosses 75 % of the V8 heap limit.
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import {
  resolveGatewayLogsDir,
  resolveMemoryLogPath,
  writeLastExitRecord,
} from "../infra/gateway-crash-log.js";
import { getTotalQueueSize } from "../process/command-queue.js";

export const MEMORY_SAMPLE_INTERVAL_MS = 60_000;
export const MEMORY_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const AUTO_HEAP_SNAPSHOT_RATIO = 0.75;

export type GatewayMemorySample = {
  at: number;
  pid: number;
  uptimeMs: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  activeRuns?: number;
  queueDepth?: number;
};

type SampleSources = {
  now?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  uptimeMs?: () => number;
  activeRuns?: () => number;
  queueDepth?: () => number;
};

export function collectMemorySample(sources: SampleSources = {}): GatewayMemorySample {
  const mem = (sources.memoryUsage ?? process.memoryUsage)();
  const sample: GatewayMemorySample = {
    at: (sources.now ?? Date.now)(),
    pid: process.pid,
    uptimeMs: Math.round((sources.uptimeMs ?? (() => process.uptime() * 1000))()),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
  };
  // sessionsLoaded is omitted: transcripts are opened per run, there is no loaded-session registry
  // to count without new tracking (§2 allows omitting such fields).
  try {
    sample.activeRuns = (sources.activeRuns ?? getActiveEmbeddedRunCount)();
  } catch {
    // omit
  }
  try {
    sample.queueDepth = (sources.queueDepth ?? getTotalQueueSize)();
  } catch {
    // omit
  }
  return sample;
}

/** Drop the oldest half of the file (on a line boundary) once it reaches `maxBytes`. */
export function rotateMemoryLog(file: string, maxBytes: number = MEMORY_LOG_MAX_BYTES): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size < maxBytes) {
    return false;
  }
  const buf = fs.readFileSync(file);
  // First line start at or after the midpoint.
  const nl = buf.indexOf(0x0a, Math.max(0, Math.floor(buf.length / 2) - 1));
  const cut = nl === -1 ? buf.length : nl + 1;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf.subarray(cut), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

export function appendMemorySample(
  sample: GatewayMemorySample,
  opts: { file?: string; maxBytes?: number } = {},
): void {
  const file = opts.file ?? resolveMemoryLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(sample)}\n`;
  const maxBytes = opts.maxBytes ?? MEMORY_LOG_MAX_BYTES;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // new file
  }
  if (size + Buffer.byteLength(line) >= maxBytes) {
    rotateMemoryLog(file, 0);
  }
  fs.appendFileSync(file, line, { mode: 0o600 });
}

function snapshotTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

/** §3.1: synchronous; pauses the process for the duration of the write. */
export function writeGatewayHeapSnapshot(
  opts: { dir?: string; now?: number; tag?: string } = {},
): string {
  const dir = opts.dir ?? resolveGatewayLogsDir();
  fs.mkdirSync(dir, { recursive: true });
  const tag = opts.tag ? `-${opts.tag}` : "";
  const file = path.join(
    dir,
    `heap-${snapshotTimestamp(opts.now ?? Date.now())}${tag}.heapsnapshot`,
  );
  return v8.writeHeapSnapshot(file);
}

export type MemorySamplerLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export type MemorySamplerOptions = {
  log: MemorySamplerLog;
  intervalMs?: number;
  file?: string;
  maxBytes?: number;
  heapLimit?: () => number;
  sources?: SampleSources;
  writeSnapshot?: () => string;
  recordNearHeapLimit?: typeof writeLastExitRecord;
};

const AUTO_SNAPSHOT_KEY = Symbol.for("openclaw.gatewayAutoHeapSnapshotTaken");
type AutoSnapshotHolder = { [AUTO_SNAPSHOT_KEY]?: boolean };

function autoSnapshotTaken(): boolean {
  return Boolean((process as AutoSnapshotHolder)[AUTO_SNAPSHOT_KEY]);
}

function markAutoSnapshotTaken(): void {
  (process as AutoSnapshotHolder)[AUTO_SNAPSHOT_KEY] = true;
}

/** Test-only. */
export function resetAutoHeapSnapshotForTest(): void {
  (process as AutoSnapshotHolder)[AUTO_SNAPSHOT_KEY] = false;
}

/** One sample + §3.2 threshold check. Exposed for tests; the sampler calls it on each tick. */
export function runMemorySampleTick(opts: MemorySamplerOptions): GatewayMemorySample | null {
  let sample: GatewayMemorySample;
  try {
    sample = collectMemorySample(opts.sources);
    appendMemorySample(sample, { file: opts.file, maxBytes: opts.maxBytes });
  } catch (err) {
    opts.log.warn(`memory sample failed: ${String(err)}`);
    return null;
  }
  if (!autoSnapshotTaken()) {
    const limit = (opts.heapLimit ?? (() => v8.getHeapStatistics().heap_size_limit))();
    if (limit > 0 && sample.heapUsed >= limit * AUTO_HEAP_SNAPSHOT_RATIO) {
      markAutoSnapshotTaken();
      const pct = Math.round((sample.heapUsed / limit) * 100);
      // §1.3: the closest node gets to a near-heap-limit hook. If the process later dies of a
      // hard OOM (which writes nothing), the next start reports this instead of "unknown".
      // Any later, more specific exit record overwrites it; a clean stop discards it.
      (opts.recordNearHeapLimit ?? writeLastExitRecord)({
        kind: "near-heap-limit",
        message: `heapUsed ${sample.heapUsed} bytes = ${pct}% of heap limit ${limit} bytes`,
      });
      opts.log.warn(
        `heapUsed at ${pct}% of heap limit; writing one automatic heap snapshot (process pauses)`,
      );
      try {
        const file = (opts.writeSnapshot ?? (() => writeGatewayHeapSnapshot({ tag: "auto" })))();
        opts.log.warn(`automatic heap snapshot written: ${file}`);
      } catch (err) {
        opts.log.warn(`automatic heap snapshot failed: ${String(err)}`);
      }
    }
  }
  return sample;
}

export function startGatewayMemorySampler(opts: MemorySamplerOptions): () => void {
  // First sample right away so even a short-lived run leaves evidence.
  runMemorySampleTick(opts);
  const timer = setInterval(() => {
    runMemorySampleTick(opts);
  }, opts.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
