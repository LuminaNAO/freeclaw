export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 1_000;

// These only shape the no-output (idle) watchdog when a whole-run cap is configured: the window is a
// ratio of the cap, clamped to [minMs, maxMs]. Without a cap the agent idle window applies instead
// (agents.defaults.idleTimeoutSeconds), so a CLI run that keeps producing output is never killed by
// wall-clock time.
export const CLI_FRESH_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.8,
  minMs: 180_000,
  maxMs: 600_000,
} as const;

export const CLI_RESUME_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.3,
  minMs: 60_000,
  maxMs: 180_000,
} as const;
