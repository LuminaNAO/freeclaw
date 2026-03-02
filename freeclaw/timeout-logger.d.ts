/**
 * Minimal timeout logging utility for FreeClaw
 */

export function logInferenceTimeout(timeoutMs: number, provider?: string, context?: string): void;
export function logFalseRateLimit(
  provider: string,
  errorMessage: string,
  expectedBehavior: string,
): void;
export function logProfileRotation(reason: string, profile: string): void;
