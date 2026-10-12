// `openclaw gateway crashes` (docs/design/gateway-crash-log.md §1.5) and
// `openclaw gateway heap-snapshot` (§3.1).
import { readBestEffortConfig } from "../../config/config.js";
import { type GatewayCrashEntry, readCrashEntries } from "../../infra/gateway-crash-log.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { callGatewayCli, type GatewayRpcOpts } from "./call.js";

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatUptime(ms: number | null): string {
  if (ms === null) {
    return "unknown";
  }
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatCrashLines(entries: GatewayCrashEntry[]): string[] {
  if (entries.length === 0) {
    return ["No gateway crashes recorded."];
  }
  return entries.map((entry) => {
    const heap = entry.lastHeap
      ? `heap ${formatBytes(entry.lastHeap.heapUsed)} rss ${formatBytes(entry.lastHeap.rss)}`
      : "heap unknown";
    return `${new Date(entry.detectedAt).toISOString()}  pid=${entry.pid}  v${entry.version}  uptime ${formatUptime(entry.uptimeMs)}  ${heap}  ${entry.reason}`;
  });
}

export function parseLimitOption(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return Math.floor(n);
}

/** Reads the file directly: works with the gateway down. */
export async function runGatewayCrashes(opts: { json?: boolean; limit?: unknown }): Promise<void> {
  const entries = readCrashEntries({ limit: parseLimitOption(opts.limit) });
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(entries, null, 2));
    return;
  }
  for (const line of formatCrashLines(entries)) {
    defaultRuntime.log(line);
  }
}

export async function runGatewayHeapSnapshot(opts: GatewayRpcOpts): Promise<void> {
  const rich = isRich();
  if (!opts.json) {
    defaultRuntime.error(
      colorize(
        rich,
        theme.warn,
        "Warning: the gateway pauses for several seconds while the snapshot is written, and the file is large (roughly the size of the heap).",
      ),
    );
  }
  const config = await readBestEffortConfig();
  const result = (await callGatewayCli(
    "gateway.heapSnapshot",
    { ...opts, config, timeout: opts.timeout ?? "300000", json: true },
    {},
  )) as { path?: string; durationMs?: number };
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }
  defaultRuntime.log(result?.path ?? "");
}
