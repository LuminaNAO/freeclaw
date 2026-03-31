/**
 * Inference event logger for FreeClaw local provider diagnostics.
 */

export function logAttemptStart(opts: {
  runId: string;
  provider: string;
  timeoutMs: number;
  hasAbortSignal: boolean;
}): void;

export function logInferenceTimeout(timeoutMs: number, provider?: string, context?: string): void;

export function logLocalTimeoutSuppressed(opts: {
  runId: string;
  provider: string;
  timeoutMs: number;
  elapsedMs: number;
}): void;

export function logInferenceStop(runId: string, reason: string, sessionId: string, durationMs?: number): void;

export function logExternalAbort(opts: {
  runId: string;
  provider: string;
  elapsedMs: number;
  reason: string;
}): void;

export function logYieldAbort(opts: { runId: string; elapsedMs: number }): void;

export function logUndiciTimeout(opts: { timeoutMs: number; kind: string }): void;

export function logFalseRateLimit(provider: string, errorMessage: string, expectedBehavior: string): void;

export function logProfileRotation(reason: string, profile: string): void;
