/**
 * Heartbeat session compaction threshold (docs/design/heartbeat-compaction.md §3).
 *
 * W = max context window of the model the heartbeat session uses.
 * - Default threshold: min(100k, 0.5 × W).
 * - Explicit `heartbeat.compactAt` (tokens) is clamped to min(150k, 0.5 × W).
 * - `heartbeat.compactAt: "off"` disables heartbeat compaction.
 */

export const HEARTBEAT_COMPACT_DEFAULT_TOKENS = 100_000;
export const HEARTBEAT_COMPACT_MAX_TOKENS = 150_000;
export const HEARTBEAT_COMPACT_MAX_WINDOW_SHARE = 0.5;

export type HeartbeatCompactAt = number | "off" | undefined;

export function isHeartbeatCompactionOff(compactAt: unknown): boolean {
  return typeof compactAt === "string" && compactAt.trim().toLowerCase() === "off";
}

/**
 * Returns the token count above which the heartbeat session is compacted,
 * or null when heartbeat compaction is disabled or the window is unknown.
 */
export function resolveHeartbeatCompactionThreshold(params: {
  contextWindowTokens: number | undefined;
  compactAt?: HeartbeatCompactAt;
}): number | null {
  if (isHeartbeatCompactionOff(params.compactAt)) {
    return null;
  }
  const window = params.contextWindowTokens;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
    return null;
  }
  const halfWindow = Math.floor(window * HEARTBEAT_COMPACT_MAX_WINDOW_SHARE);
  const explicit =
    typeof params.compactAt === "number" &&
    Number.isFinite(params.compactAt) &&
    params.compactAt > 0
      ? Math.floor(params.compactAt)
      : undefined;
  if (explicit === undefined) {
    return Math.min(HEARTBEAT_COMPACT_DEFAULT_TOKENS, halfWindow);
  }
  return Math.min(explicit, HEARTBEAT_COMPACT_MAX_TOKENS, halfWindow);
}
