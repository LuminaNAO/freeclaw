import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createRunDeadline,
  isAgentTimeoutCapped,
  NO_AGENT_TIMEOUT_MS,
  resolveAgentIdleTimeoutMs,
  resolveAgentTimeoutMs,
  runDeadlineParams,
} from "./timeout.js";

const cfgWith = (defaults: Record<string, unknown>): OpenClawConfig =>
  ({ agents: { defaults } }) as unknown as OpenClawConfig;

/**
 * Independent coverage for the three audit-HIGH timeout findings, verified from the task
 * contract rather than from the implementation:
 *   A1 an explicitly configured run limit must apply to local providers too.
 *   A2 local providers must still get the default stall window (a wedged local request is a stall).
 *   A3 one run deadline must be shared across fallback/retry boundaries, not reset per attempt.
 */
describe("audit A1: explicit run limit applies to local providers", () => {
  it("caps a local provider at the configured timeoutSeconds", () => {
    // Regression: a positive limit used to be converted to "no timeout" for ollama/vllm/llama.cpp.
    const cfg = cfgWith({ timeoutSeconds: 60 });
    for (const provider of ["ollama", "vllm", "llama.cpp", "local"]) {
      expect(resolveAgentTimeoutMs({ cfg, provider })).toBe(60_000);
    }
  });

  it("keeps local providers uncapped only when no limit is configured", () => {
    for (const provider of ["ollama", "vllm", "llama.cpp"]) {
      expect(resolveAgentTimeoutMs({ provider })).toBe(NO_AGENT_TIMEOUT_MS);
      expect(isAgentTimeoutCapped(resolveAgentTimeoutMs({ provider }))).toBe(false);
    }
  });

  it("honours a per-run override over config for local providers", () => {
    expect(
      resolveAgentTimeoutMs({
        cfg: cfgWith({ timeoutSeconds: 60 }),
        overrideSeconds: 30,
        provider: "ollama",
      }),
    ).toBe(30_000);
  });

  it("treats an explicit 0 as uncapped for local providers", () => {
    expect(
      resolveAgentTimeoutMs({
        cfg: cfgWith({ timeoutSeconds: 60 }),
        overrideSeconds: 0,
        provider: "ollama",
      }),
    ).toBe(NO_AGENT_TIMEOUT_MS);
  });
});

describe("audit A2: local providers get the default stall window", () => {
  it("resolves the 600s default idle window regardless of provider", () => {
    // resolveAgentIdleTimeoutMs takes no provider: a wedged local request is a stall like any other.
    expect(resolveAgentIdleTimeoutMs({})).toBe(600_000);
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({}) })).toBe(600_000);
  });

  it("honours a configured idle window for a run on a local provider", () => {
    const cfg = cfgWith({ idleTimeoutSeconds: 45 });
    expect(resolveAgentIdleTimeoutMs({ cfg })).toBe(45_000);
    // And the local provider stays uncapped on wall-clock while the stall window applies.
    expect(resolveAgentTimeoutMs({ cfg, provider: "ollama" })).toBe(NO_AGENT_TIMEOUT_MS);
  });

  it("disables the stall window only on an explicit 0", () => {
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 0 }) })).toBe(0);
  });
});

describe("audit A3: one shared run deadline across fallback and retry boundaries", () => {
  it("drains remaining budget instead of resetting per attempt", () => {
    let now = 0;
    const deadline = createRunDeadline(60_000, () => now);

    expect(runDeadlineParams(deadline)).toMatchObject({ timeoutMs: 60_000, runLimitMs: 60_000 });

    // First attempt fails at 40s: the next candidate must get only what is left, not a fresh 60s.
    now = 40_000;
    expect(runDeadlineParams(deadline)).toMatchObject({ timeoutMs: 20_000, runLimitMs: 60_000 });

    now = 55_000;
    expect(runDeadlineParams(deadline)).toMatchObject({ timeoutMs: 5_000, runLimitMs: 60_000 });
  });

  it("never hands an attempt a non-positive budget as the limit elapses", () => {
    let now = 0;
    const deadline = createRunDeadline(60_000, () => now);

    now = 60_000;
    expect(deadline.expired()).toBe(true);
    expect(runDeadlineParams(deadline).timeoutMs).toBeGreaterThanOrEqual(1);

    now = 90_000;
    expect(deadline.expired()).toBe(true);
    expect(runDeadlineParams(deadline).timeoutMs).toBeGreaterThanOrEqual(1);
  });

  it("keeps an uncapped run uncapped across attempts (never expires)", () => {
    let now = 0;
    const deadline = createRunDeadline(NO_AGENT_TIMEOUT_MS, () => now);

    expect(isAgentTimeoutCapped(deadline.limitMs)).toBe(false);
    expect(deadline.expired()).toBe(false);

    // A healthy 40-minute run must still have its full uncapped budget.
    now = 40 * 60_000;
    expect(deadline.expired()).toBe(false);
    expect(runDeadlineParams(deadline)).toEqual({
      timeoutMs: NO_AGENT_TIMEOUT_MS,
      runLimitMs: NO_AGENT_TIMEOUT_MS,
    });
  });
});
