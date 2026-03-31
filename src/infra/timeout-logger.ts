/**
 * Inference event logger for FreeClaw local provider diagnostics.
 * Writes to $HOME/timeout.log — covers all abort/cancel/timeout events
 * so root causes can be identified from the log alone.
 *
 * Log format: [ISO_TIMESTAMP] TYPE provider=X runId=Y elapsedMs=Z | message
 */

import { appendFileSync } from "fs";

const LOG_PATH = `${process.env.HOME}/timeout.log`;

function write(type: string, fields: Record<string, string | number | boolean | undefined>, message: string) {
  const ts = new Date().toISOString();
  const fieldStr = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const line = `[${ts}] ${type} ${fieldStr} | ${message}\n`;
  try {
    appendFileSync(LOG_PATH, line, "utf-8");
  } catch {
    // Best-effort — never throw from a logger
  }
}

// ─── Run lifecycle ────────────────────────────────────────────────────────────

/** Log the start of an embedded attempt — confirms what timeoutMs and abortSignal were wired in. */
export function logAttemptStart(opts: {
  runId: string;
  provider: string;
  timeoutMs: number;
  hasAbortSignal: boolean;
}) {
  write("ATTEMPT_START", {
    runId: opts.runId,
    provider: opts.provider,
    timeoutMs: opts.timeoutMs,
    hasAbortSignal: opts.hasAbortSignal,
  }, `attempt started timeoutMs=${opts.timeoutMs} hasAbortSignal=${opts.hasAbortSignal}`);
}

// ─── Abort events ─────────────────────────────────────────────────────────────

/**
 * Log when abortRun() fires for a timeout.
 * For local providers the abort is SKIPPED — this still fires so we know the timer
 * triggered, and whether it was suppressed.
 */
export function logInferenceTimeout(timeoutMs: number, provider?: string, context?: string) {
  write("TIMEOUT", { provider, timeoutMs }, `timer fired${context ? ` (${context})` : ""}`);
}

/**
 * Log when abortRun() fires for a timeout on a LOCAL provider and the abort is suppressed.
 * This distinguishes "timer fired but we let it run" from "timer never fired".
 */
export function logLocalTimeoutSuppressed(opts: {
  runId: string;
  provider: string;
  timeoutMs: number;
  elapsedMs: number;
}) {
  write("TIMEOUT_SUPPRESSED", opts, `local provider timeout suppressed — inference allowed to continue`);
}

/**
 * Log when abortRun() fires for a non-timeout reason (stop-command).
 */
export function logInferenceStop(runId: string, reason: string, sessionId: string, durationMs?: number) {
  write("STOP", { runId, sessionId, durationMs }, `stopped: ${reason}`);
}

/**
 * Log when an EXTERNAL AbortSignal (params.abortSignal) fires mid-run.
 * This is NOT guarded for local providers — if it fires, the run dies.
 * This is critical to capture because it's the most likely unknown cause.
 */
export function logExternalAbort(opts: {
  runId: string;
  provider: string;
  elapsedMs: number;
  reason: string;
}) {
  write("EXTERNAL_ABORT", opts, `external abortSignal fired after ${opts.elapsedMs}ms — reason: ${opts.reason}`);
}

/**
 * Log when a sessions_yield abort fires.
 */
export function logYieldAbort(opts: { runId: string; elapsedMs: number }) {
  write("YIELD_ABORT", opts, `sessions_yield abort after ${opts.elapsedMs}ms`);
}

// ─── Undici / HTTP layer ──────────────────────────────────────────────────────

/**
 * Log when the undici global dispatcher timeout is configured.
 * Confirms the 30-min timeout is active before each inference attempt.
 */
export function logUndiciTimeout(opts: { timeoutMs: number; kind: string }) {
  write("UNDICI_TIMEOUT", opts, `undici dispatcher set: bodyTimeout=${opts.timeoutMs}ms headersTimeout=${opts.timeoutMs}ms kind=${opts.kind}`);
}

// ─── Other diagnostic events ──────────────────────────────────────────────────

export function logFalseRateLimit(provider: string, errorMessage: string, expectedBehavior: string) {
  write("RATE_LIMIT", { provider }, `rate limit incorrectly flagged: "${errorMessage}". Expected: ${expectedBehavior}`);
}

export function logProfileRotation(reason: string, profile: string) {
  write("PROFILE_ROTATION", { profile }, `rotation triggered: ${reason}`);
}
