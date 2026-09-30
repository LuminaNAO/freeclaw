import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  assertRunDeadline,
  createRunDeadline,
  RunDeadlineExceededError,
  isAgentTimeoutCapped,
  NO_AGENT_TIMEOUT_MS,
  resolveAgentIdleTimeoutMs,
  resolveAgentTimeoutMs,
  resolveAgentTimeoutSeconds,
} from "./timeout.js";

const cfgWith = (defaults: Record<string, unknown>) =>
  ({ agents: { defaults } }) as unknown as OpenClawConfig;

describe("resolveAgentTimeoutMs", () => {
  it("has no wall-clock cap when timeoutSeconds is unset", () => {
    expect(resolveAgentTimeoutSeconds(undefined)).toBeUndefined();
    const ms = resolveAgentTimeoutMs({ cfg: cfgWith({}) });
    expect(ms).toBe(NO_AGENT_TIMEOUT_MS);
    expect(isAgentTimeoutCapped(ms)).toBe(false);
  });

  it("enforces an explicitly configured cap", () => {
    const ms = resolveAgentTimeoutMs({ cfg: cfgWith({ timeoutSeconds: 900 }) });
    expect(ms).toBe(900_000);
    expect(isAgentTimeoutCapped(ms)).toBe(true);
  });

  it("honors per-run overrides; 0 means no cap and negative falls back to config", () => {
    const cfg = cfgWith({ timeoutSeconds: 900 });
    expect(resolveAgentTimeoutMs({ cfg, overrideSeconds: 30 })).toBe(30_000);
    expect(resolveAgentTimeoutMs({ cfg, overrideMs: 1234 })).toBe(1234);
    expect(resolveAgentTimeoutMs({ cfg, overrideSeconds: 0 })).toBe(NO_AGENT_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ cfg, overrideSeconds: -1 })).toBe(900_000);
    expect(resolveAgentTimeoutMs({ cfg: cfgWith({}), overrideSeconds: -1 })).toBe(
      NO_AGENT_TIMEOUT_MS,
    );
  });

  it("applies an explicitly configured limit to local providers too", () => {
    const cfg = cfgWith({ timeoutSeconds: 900 });
    expect(resolveAgentTimeoutMs({ cfg, provider: "ollama" })).toBe(900_000);
    expect(resolveAgentTimeoutMs({ cfg: cfgWith({}), provider: "ollama" })).toBe(
      NO_AGENT_TIMEOUT_MS,
    );
  });
});

describe("resolveAgentIdleTimeoutMs", () => {
  it("defaults to 10 minutes", () => {
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({}) })).toBe(600_000);
  });

  it("uses agents.defaults.idleTimeoutSeconds and 0 disables", () => {
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 120 }) })).toBe(120_000);
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 0 }) })).toBe(0);
  });

  it("per-run override wins over config", () => {
    expect(
      resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 120 }), overrideSeconds: 5 }),
    ).toBe(5_000);
  });
});

describe("createRunDeadline", () => {
  it("shrinks a capped limit and reports expiry", () => {
    let t = 1_000;
    const d = createRunDeadline(60_000, () => t);
    expect(d.remainingMs()).toBe(60_000);
    t += 59_000;
    expect(d.remainingMs()).toBe(1_000);
    expect(d.expired()).toBe(false);
    t += 5_000;
    expect(d.remainingMs()).toBe(0);
    expect(d.expired()).toBe(true);
    expect(d.limitMs).toBe(60_000);
    expect(d.deadlineAtMs).toBe(61_000);
    // A spent budget is never turned into a fresh attempt.
    expect(() => assertRunDeadline(d)).toThrow(RunDeadlineExceededError);
    expect(() => assertRunDeadline(d)).toThrow("Run exceeded configured limit of 60s");
  });

  it("stays uncapped", () => {
    let t = 0;
    const d = createRunDeadline(NO_AGENT_TIMEOUT_MS, () => t);
    t += 10 * 24 * 3_600_000;
    expect(d.remainingMs()).toBe(NO_AGENT_TIMEOUT_MS);
    expect(d.expired()).toBe(false);
  });
});
