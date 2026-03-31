/**
 * Inference event logger for FreeClaw local provider diagnostics.
 * Writes to $HOME/timeout.log — covers all abort/cancel/timeout events.
 */

import { appendFileSync } from "fs";

const LOG_PATH = `${process.env.HOME}/timeout.log`;

function write(type, fields, message) {
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

export function logAttemptStart(opts) {
  write("ATTEMPT_START", {
    runId: opts.runId,
    provider: opts.provider,
    timeoutMs: opts.timeoutMs,
    hasAbortSignal: opts.hasAbortSignal,
  }, `attempt started timeoutMs=${opts.timeoutMs} hasAbortSignal=${opts.hasAbortSignal}`);
}

export function logInferenceTimeout(timeoutMs, provider, context) {
  write("TIMEOUT", { provider, timeoutMs }, `timer fired${context ? ` (${context})` : ""}`);
}

export function logLocalTimeoutSuppressed(opts) {
  write("TIMEOUT_SUPPRESSED", opts, `local provider timeout suppressed — inference allowed to continue`);
}

export function logInferenceStop(runId, reason, sessionId, durationMs) {
  write("STOP", { runId, sessionId, durationMs }, `stopped: ${reason}`);
}

export function logExternalAbort(opts) {
  write("EXTERNAL_ABORT", opts, `external abortSignal fired after ${opts.elapsedMs}ms — reason: ${opts.reason}`);
}

export function logYieldAbort(opts) {
  write("YIELD_ABORT", opts, `sessions_yield abort after ${opts.elapsedMs}ms`);
}

export function logUndiciTimeout(opts) {
  write("UNDICI_TIMEOUT", opts, `undici dispatcher set: bodyTimeout=${opts.timeoutMs}ms headersTimeout=${opts.timeoutMs}ms kind=${opts.kind}`);
}

export function logFalseRateLimit(provider, errorMessage, expectedBehavior) {
  write("RATE_LIMIT", { provider }, `rate limit incorrectly flagged: "${errorMessage}". Expected: ${expectedBehavior}`);
}

export function logProfileRotation(reason, profile) {
  write("PROFILE_ROTATION", { profile }, `rotation triggered: ${reason}`);
}
