import type { OpenClawConfig } from "../config/config.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

// Local inference providers (llama.cpp, ollama, vllm, etc.) can take minutes
// per response — the cloud-oriented 600s default is unsafe for them.
const LOCAL_PROVIDER_HINTS = ["ollama", "vllm", "llama.cpp", "local", "ollama.cpp"];

export function isLocalInferenceProvider(provider?: string | null): boolean {
  if (!provider) return false;
  const p = provider.toLowerCase();
  return LOCAL_PROVIDER_HINTS.some((hint) => p.includes(hint));
}

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

export function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
  /** When set, local providers default to no-timeout instead of the 600s cloud default. */
  provider?: string | null;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const clampTimeoutMs = (valueMs: number) =>
    Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS);
  const defaultMs = clampTimeoutMs(resolveAgentTimeoutSeconds(opts.cfg) * 1000);
  // Use the maximum timer-safe timeout to represent "no timeout" when explicitly set to 0.
  const NO_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideSeconds * 1000);
  }
  // No explicit override: local providers get no-timeout by default since their
  // generation time is unbounded and the 600s cloud default would kill long runs.
  if (isLocalInferenceProvider(opts.provider)) {
    return NO_TIMEOUT_MS;
  }
  return defaultMs;
}
