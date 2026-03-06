#!/usr/bin/env node
/**
 * Minimal timeout logging utility for FreeClaw
 * Writes timeout events to $HOME/timeout.log
 * Format: [TIMESTAMP] TYPE: message
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
 * Log a timeout event
 * @param type - Event type (TIMEOUT, RATE_LIMIT, etc.)
 * @param message - Message to log
 */
export function logTimeout(type, message) {
  ensureLogFile();
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${type}: ${message}\n`;
  appendFileSync(LOG_PATH, logEntry, "utf-8");
}

/**
 * Log when an inference task is killed due to timeout
 * @param timeoutMs - The timeout value that was reached
 * @param provider - The provider that timed out (ollama, vllm, etc.)
 * @param context - Additional context about what was happening
 */
export function logInferenceTimeout(timeoutMs, provider, context) {
  let message = `10-min inference killed at ${timeoutMs}ms`;
  if (provider) {
    message += ` (provider: ${provider})`;
  }
  if (context) {
    message += ` (${context})`;
  }
  logTimeout("TIMEOUT", message);
}

/**
 * Log when a rate-limit error is incorrectly detected for a local provider
 * @param provider - The local provider that was incorrectly flagged
 * @param errorMessage - The error message that triggered the detection
 * @param expectedBehavior - What should have happened instead
 */
export function logFalseRateLimit(provider, errorMessage, expectedBehavior) {
  const message = `Rate limit incorrectly flagged for local provider ${provider}: "${errorMessage}". Expected: ${expectedBehavior}`;
  logTimeout("RATE_LIMIT", message);
}

/**
 * Log when profile rotation is triggered
 * @param reason - Why profile rotation was triggered
 * @param profile - The profile that was rotated
 */
export function logProfileRotation(reason, profile) {
  const message = `Profile rotation triggered: ${reason} (profile: ${profile})`;
  logTimeout("PROFILE_ROTATION", message);
}
