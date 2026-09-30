import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import { resolveCliNoOutputTimeoutMs } from "./helpers.js";

/**
 * CLI-backend watchdog must follow the same idle-not-wallclock rule as the agent run:
 * it measures "no output for N", never a fraction of "how long the whole run may take".
 * Pre-runcap, fresh runs derived the window as noOutputTimeoutRatio * timeoutMs
 * (0.8 * 700s -> 560s), i.e. the idle budget shrank or grew with the run cap. That
 * coupling is the thing under test here.
 */
const NO_TIMEOUT_MS = 2_147_000_000;
const DEFAULT_IDLE_MS = 600_000;

type WatchdogConfig = NonNullable<NonNullable<CliBackendConfig["reliability"]>["watchdog"]>;

const backend = (watchdog?: WatchdogConfig): CliBackendConfig =>
  ({ command: "codex", reliability: watchdog ? { watchdog } : undefined }) as CliBackendConfig;

const resolve = (params: {
  timeoutMs: number;
  useResume?: boolean;
  watchdog?: WatchdogConfig;
  idleTimeoutMs?: number;
}) =>
  resolveCliNoOutputTimeoutMs({
    backend: backend(params.watchdog),
    timeoutMs: params.timeoutMs,
    useResume: params.useResume ?? false,
    idleTimeoutMs: params.idleTimeoutMs,
  });

describe("runcap: CLI watchdog is an idle window, not a wall-clock fraction", () => {
  it("defaults to the 10 minute idle window when the run is uncapped", () => {
    expect(resolve({ timeoutMs: NO_TIMEOUT_MS })).toBe(DEFAULT_IDLE_MS);
  });

  it("uses the idle window, not a fraction of the sentinel, when uncapped", () => {
    // Pre-runcap an uncapped run resolved to 0.8 * 2_147_000_000, i.e. a ~20 day watchdog
    // that could never fire. The idle window must govern instead.
    expect(resolve({ timeoutMs: NO_TIMEOUT_MS })).toBe(DEFAULT_IDLE_MS);
    expect(resolve({ timeoutMs: NO_TIMEOUT_MS })).not.toBeGreaterThan(NO_TIMEOUT_MS);
  });

  it("honours a configured idle window when uncapped", () => {
    expect(resolve({ timeoutMs: NO_TIMEOUT_MS, idleTimeoutMs: 1_800_000 })).toBe(1_800_000);
    expect(resolve({ timeoutMs: NO_TIMEOUT_MS, idleTimeoutMs: 45_000 })).toBe(45_000);
  });

  it("keeps an explicitly configured whole-run cap binding the watchdog", () => {
    // An explicit timeoutSeconds is opt-in and must keep working: the watchdog stays under
    // the cap so a capped run aborts at its limit rather than idling past it.
    const capped = resolve({ timeoutMs: 700_000 });
    expect(capped).toBeLessThan(700_000);
    expect(capped).toBeGreaterThan(0);
  });

  it("returns a finite idle window rather than anything derived from the no-timeout sentinel", () => {
    const ms = resolve({ timeoutMs: NO_TIMEOUT_MS });
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
    // A sentinel-derived ratio would be ~24 days.
    expect(ms).toBeLessThan(24 * 60 * 60_000);
  });

  it("gives resumed runs a finite idle window when uncapped", () => {
    const ms = resolve({ timeoutMs: NO_TIMEOUT_MS, useResume: true });
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(24 * 60 * 60_000);
  });

  it("honours a configured idle window larger than the legacy 600s max", () => {
    // Pre-runcap this was clamped by CLI_FRESH_WATCHDOG_DEFAULTS.maxMs (600_000) and by
    // (timeoutMs - 1000). With the run uncapped, a long-but-alive backend command must
    // be allowed its full idle budget.
    expect(
      resolve({ timeoutMs: NO_TIMEOUT_MS, watchdog: { fresh: { noOutputTimeoutMs: 1_800_000 } } }),
    ).toBe(1_800_000);
  });

  it("honours a configured resume idle window larger than the legacy 180s max", () => {
    expect(
      resolve({
        timeoutMs: NO_TIMEOUT_MS,
        useResume: true,
        watchdog: { resume: { noOutputTimeoutMs: 900_000 } },
      }),
    ).toBe(900_000);
  });

  it("keeps an explicit configured override working under a real cap", () => {
    expect(
      resolve({
        timeoutMs: 120_000,
        useResume: true,
        watchdog: { resume: { noOutputTimeoutMs: 42_000 } },
      }),
    ).toBe(42_000);
  });
});
