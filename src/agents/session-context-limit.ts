import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "./context-window-constants.js";

/**
 * Session context limit ARCH §1: the pure rules for a session's own `contextLimit`.
 *
 * A stored value counts only when it is an integer at or above `CONTEXT_WINDOW_HARD_MIN_TOKENS`.
 * Anything else (absent, malformed, hand-edited) is ignored, so a bad value can never block a run
 * or raise a window.
 */
export function normalizeSessionContextLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  return value >= CONTEXT_WINDOW_HARD_MIN_TOKENS ? value : undefined;
}

/**
 * Session context limit ARCH §1.2: the one place a session limit is applied to a resolved window.
 * It only ever lowers: the result is the lower of the two. With no valid limit, or a limit at or
 * above the window, the input is returned unchanged (the same object).
 */
export function applySessionContextLimit<T extends { tokens: number; source: string }>(
  info: T,
  contextLimit: unknown,
): T | { tokens: number; source: "sessionContextLimit" } {
  const limit = normalizeSessionContextLimit(contextLimit);
  if (limit === undefined || limit >= info.tokens) {
    return info;
  }
  return { tokens: limit, source: "sessionContextLimit" };
}

/**
 * Number form of {@link applySessionContextLimit} for callers that carry a bare token count.
 * Returns the input unchanged unless a valid limit is strictly lower.
 */
export function applySessionContextLimitToTokens<T extends number | null | undefined>(
  tokens: T,
  contextLimit: unknown,
): T | number {
  const limit = normalizeSessionContextLimit(contextLimit);
  if (limit === undefined || typeof tokens !== "number" || limit >= tokens) {
    return tokens;
  }
  return limit;
}
