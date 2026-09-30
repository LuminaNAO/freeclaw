import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentIdleTimeoutMs, resolveAgentTimeoutMs } from "./timeout.js";

const NO_TIMEOUT_MS = 2_147_000_000;

const cfgWith = (defaults: Record<string, unknown>): OpenClawConfig =>
  ({ agents: { defaults } }) as unknown as OpenClawConfig;

describe("runcap: idle (stall) watchdog window resolution", () => {
  it("defaults to a 10 minute idle window when idleTimeoutSeconds is unset", () => {
    expect(resolveAgentIdleTimeoutMs({})).toBe(600_000);
    expect(resolveAgentIdleTimeoutMs({ cfg: {} })).toBe(600_000);
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({}) })).toBe(600_000);
  });

  it("honours a configured idle window", () => {
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 45 }) })).toBe(45_000);
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 1800 }) })).toBe(
      1_800_000,
    );
  });

  it("honours a per-run idle override", () => {
    expect(resolveAgentIdleTimeoutMs({ overrideSeconds: 90 })).toBe(90_000);
    expect(
      resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 45 }), overrideSeconds: 15 }),
    ).toBe(15_000);
  });

  it("treats idleTimeoutSeconds: 0 as disabling the stall watchdog", () => {
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 0 }) })).toBe(0);
    expect(resolveAgentIdleTimeoutMs({ overrideSeconds: 0 })).toBe(0);
  });

  it("resolves the idle window independently of any wall-clock cap", () => {
    // Stall detection must survive removal of the run cap, and must not inherit it.
    const cfg = cfgWith({ idleTimeoutSeconds: 300 });
    expect(resolveAgentTimeoutMs({ cfg })).toBe(NO_TIMEOUT_MS);
    expect(resolveAgentIdleTimeoutMs({ cfg })).toBe(300_000);
  });

  it("keeps a configured wall-clock cap without widening the idle window", () => {
    const cfg = cfgWith({ timeoutSeconds: 60, idleTimeoutSeconds: 900 });
    expect(resolveAgentTimeoutMs({ cfg })).toBe(60_000);
    expect(resolveAgentIdleTimeoutMs({ cfg })).toBe(900_000);
  });

  it("never returns a negative or fractional idle window", () => {
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: -5 }) })).toBe(0);
    expect(resolveAgentIdleTimeoutMs({ cfg: cfgWith({ idleTimeoutSeconds: 12.7 }) })).toBe(12_000);
  });
});
