import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { formatRuntimeStatusWithDetails } from "../infra/runtime-status.ts";
import type { HeartbeatStatus, SessionStatus } from "./status.types.js";
export { shortenText } from "./text-format.js";

export const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

/**
 * One "Heartbeat session" row value per agent: size, compaction threshold and last
 * compaction time (heartbeat-compaction ARCH §2.5). Null when no agent reports compaction.
 */
export function formatHeartbeatCompactionValue(
  agents: HeartbeatStatus[],
  nowMs: number = Date.now(),
): string | null {
  const parts = agents.flatMap((agent) => {
    const c = agent.compaction;
    if (!c) {
      return [];
    }
    const size = c.totalTokens != null ? formatKTokens(c.totalTokens) : "unknown";
    const threshold =
      c.threshold != null ? `compacts at ${formatKTokens(c.threshold)}` : "compaction off";
    const last =
      c.lastCompactedAt != null
        ? `last compacted ${formatTimeAgo(Math.max(0, nowMs - c.lastCompactedAt))}`
        : "never compacted";
    return [`${size} / ${threshold} · ${last} (${agent.agentId})`];
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

export const formatDuration = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) {
    return "unknown";
  }
  return formatDurationPrecise(ms, { decimals: 1 });
};

export const formatTokensCompact = (
  sess: Pick<
    SessionStatus,
    "totalTokens" | "contextTokens" | "percentUsed" | "cacheRead" | "cacheWrite"
  >,
) => {
  const used = sess.totalTokens;
  const ctx = sess.contextTokens;
  const cacheRead = sess.cacheRead;
  const cacheWrite = sess.cacheWrite;

  let result = "";
  if (used == null) {
    result = ctx ? `unknown/${formatKTokens(ctx)} (?%)` : "unknown used";
  } else if (!ctx) {
    result = `${formatKTokens(used)} used`;
  } else {
    const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
    result = `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
  }

  // Add cache hit rate if there are cached reads
  if (typeof cacheRead === "number" && cacheRead > 0) {
    const total =
      typeof used === "number"
        ? used
        : cacheRead + (typeof cacheWrite === "number" ? cacheWrite : 0);
    const hitRate = Math.round((cacheRead / total) * 100);
    result += ` · 🗄️ ${hitRate}% cached`;
  }

  return result;
};

export const formatDaemonRuntimeShort = (runtime?: {
  status?: string;
  pid?: number;
  state?: string;
  detail?: string;
  missingUnit?: boolean;
}) => {
  if (!runtime) {
    return null;
  }
  const details: string[] = [];
  const detail = runtime.detail?.replace(/\s+/g, " ").trim() || "";
  const noisyLaunchctlDetail =
    runtime.missingUnit === true && detail.toLowerCase().includes("could not find service");
  if (detail && !noisyLaunchctlDetail) {
    details.push(detail);
  }
  return formatRuntimeStatusWithDetails({
    status: runtime.status,
    pid: runtime.pid,
    state: runtime.state,
    details,
  });
};
