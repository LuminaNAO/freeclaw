import type { OpenClawConfig } from "../config/config.js";

const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;
const DEFAULT_AGENT_IDLE_TIMEOUT_SECONDS = 600;

/** Timer-safe sentinel meaning "no wall-clock cap". */
export const NO_AGENT_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;

// Local inference providers (llama.cpp, ollama, vllm, etc.) can take minutes per response.
const LOCAL_PROVIDER_HINTS = ["ollama", "vllm", "llama.cpp", "local", "ollama.cpp"];

export function isLocalInferenceProvider(provider?: string | null): boolean {
  if (!provider) {
    return false;
  }
  const p = provider.toLowerCase();
  return LOCAL_PROVIDER_HINTS.some((hint) => p.includes(hint));
}

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

/** Configured whole-run cap in seconds, or undefined when no cap is configured (the default). */
export function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number | undefined {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  if (raw === undefined || raw <= 0) {
    return undefined;
  }
  return raw;
}

export function isAgentTimeoutCapped(timeoutMs: number): boolean {
  return timeoutMs < NO_AGENT_TIMEOUT_MS;
}

/**
 * Whole-run wall-clock cap. There is no cap unless one is configured
 * (`agents.defaults.timeoutSeconds`) or passed per run; stalls are handled by the idle watchdog.
 */
export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
  provider?: string | null;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  // Finite limits stay strictly below the "no limit" sentinel so a very long explicit limit is still a limit.
  const clampTimeoutMs = (valueMs: number) =>
    Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS - 1);
  const configuredSeconds = resolveAgentTimeoutSeconds(opts.cfg);
  // An explicitly configured limit applies to every provider, local ones included.
  const configuredMs =
    configuredSeconds === undefined
      ? NO_AGENT_TIMEOUT_MS
      : clampTimeoutMs(configuredSeconds * 1000);
  const fromOverride = (value: number | undefined, unitMs: number): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (value === 0) {
      return NO_AGENT_TIMEOUT_MS;
    }
    if (value < 0) {
      return configuredMs;
    }
    return clampTimeoutMs(value * unitMs);
  };
  return (
    fromOverride(normalizeNumber(opts.overrideMs), 1) ??
    fromOverride(normalizeNumber(opts.overrideSeconds), 1000) ??
    configuredMs
  );
}

/**
 * Stall window: abort only after this long with no progress (stream deltas, tool activity,
 * live tool processes). `agents.defaults.idleTimeoutSeconds`, default 600, 0 disables.
 * Returns 0 when disabled.
 */
export function resolveAgentIdleTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideSeconds?: number | null;
}): number {
  const override = normalizeNumber(opts.overrideSeconds);
  const configured = normalizeNumber(opts.cfg?.agents?.defaults?.idleTimeoutSeconds);
  const seconds = override ?? configured ?? DEFAULT_AGENT_IDLE_TIMEOUT_SECONDS;
  if (seconds <= 0) {
    return 0;
  }
  return Math.min(seconds * 1000, MAX_SAFE_TIMEOUT_MS);
}

export type RunDeadline = {
  /** The configured whole-run limit (or the uncapped sentinel). */
  limitMs: number;
  /** Absolute epoch-ms deadline (Infinity when uncapped). */
  deadlineAtMs: number;
  /** What is left of the limit now; 0 once expired; uncapped stays the sentinel. */
  remainingMs: () => number;
  expired: () => boolean;
};

/**
 * One absolute deadline for a whole user-visible run. Model fallback candidates, CLI session retries,
 * queue waits, backoff sleeps, and outer transient retries all count against it.
 */
export function createRunDeadline(
  limitMs: number,
  now: () => number = Date.now,
  /** Caller's existing absolute deadline (shared across queue wait/fallback); defaults to now + limitMs. */
  atMs?: number,
): RunDeadline {
  const capped = isAgentTimeoutCapped(limitMs);
  const deadlineAtMs = capped ? (atMs ?? now() + limitMs) : Number.POSITIVE_INFINITY;
  return {
    limitMs,
    deadlineAtMs,
    remainingMs: () => (capped ? Math.max(0, deadlineAtMs - now()) : limitMs),
    expired: () => capped && now() >= deadlineAtMs,
  };
}

/**
 * `timeoutMs`/`runLimitMs`/`runDeadlineAtMs` for one embedded or CLI attempt drawn from a shared deadline.
 * Callers must check `expired()` first (see assertRunDeadline): a spent budget is never turned into a fresh 1 ms
 * attempt.
 */
export function runDeadlineParams(deadline: RunDeadline): {
  timeoutMs: number;
  runLimitMs: number;
  runDeadlineAtMs?: number;
} {
  return {
    timeoutMs: isAgentTimeoutCapped(deadline.limitMs)
      ? Math.max(1, deadline.remainingMs())
      : deadline.limitMs,
    runLimitMs: deadline.limitMs,
    runDeadlineAtMs: Number.isFinite(deadline.deadlineAtMs) ? deadline.deadlineAtMs : undefined,
  };
}

/** Thrown before starting more work (a fallback candidate, a retry) once the whole-run deadline has passed. */
export class RunDeadlineExceededError extends Error {
  constructor(readonly limitMs: number) {
    super(`Run exceeded configured limit of ${Math.round(limitMs / 1000)}s and was stopped.`);
    this.name = "RunDeadlineExceededError";
  }
}

export function assertRunDeadline(deadline: RunDeadline): void {
  if (deadline.expired()) {
    throw new RunDeadlineExceededError(deadline.limitMs);
  }
}

/**
 * Subagent run limit in seconds: the spawn request wins, then agents.defaults.subagents.runTimeoutSeconds.
 * Undefined means "inherit": the child run uses agents.defaults.timeoutSeconds (no cap unless configured).
 * An explicit 0 still means no cap.
 */
export function resolveSubagentRunTimeoutSeconds(
  cfg: OpenClawConfig | undefined,
  requested: number | undefined,
): number | undefined {
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return Math.max(0, Math.floor(requested));
  }
  const configured = cfg?.agents?.defaults?.subagents?.runTimeoutSeconds;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  return undefined;
}
