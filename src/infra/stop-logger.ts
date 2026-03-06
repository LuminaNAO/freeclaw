#!/usr/bin/env node
/**
 * Stop logging utility for FreeClaw
 * Writes stop events to $HOME/timeout.log
 * Format: [TIMESTAMP] STOP: message
 */

import { writeFileSync, appendFileSync, mkdirSync } from "fs";
import { existsSync } from "fs";

const LOG_PATH = `${process.env.HOME}/timeout.log`;

/**
 * Ensure the log file exists
 */
function ensureLogFile() {
  if (!existsSync(LOG_PATH)) {
    mkdirSync(`${process.env.HOME}`, { recursive: true });
    writeFileSync(LOG_PATH, "", "utf-8");
  }
}

/**
 * Log a stop event
 * @param reason - Why the run was stopped (stop-command, error, timeout, etc.)
 * @param context - Additional context (runId, sessionId, duration, etc.)
 */
export function logStop(reason: string, context?: Record<string, string>) {
  ensureLogFile();
  const timestamp = new Date().toISOString();
  const ctxParts = Object.entries(context || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const message = `Stopped: ${reason}${ctxParts ? ` (${ctxParts})` : ""}`;
  const logEntry = `[${timestamp}] STOP: ${message}\n`;
  appendFileSync(LOG_PATH, logEntry, "utf-8");
}

/**
 * Log when an inference run is stopped
 * @param runId - The run ID that was stopped
 * @param reason - Why it was stopped (stop-command, error, etc.)
 * @param sessionId - The session ID
 * @param durationMs - How long it ran (optional)
 */
export function logInferenceStop(
  runId: string,
  reason: string,
  sessionId: string,
  durationMs?: number,
) {
  const context = {
    runId,
    sessionId,
    ...(durationMs !== undefined ? { durationMs: durationMs.toString() } : {}),
  };
  logStop(reason, context);
}
