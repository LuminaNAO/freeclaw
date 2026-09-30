import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isAgentTimeoutCapped, NO_AGENT_TIMEOUT_MS, resolveAgentTimeoutMs } from "./timeout.js";

const NO_TIMEOUT_MS = NO_AGENT_TIMEOUT_MS;

const cfgWith = (defaults: Record<string, unknown>): OpenClawConfig =>
  ({ agents: { defaults } }) as unknown as OpenClawConfig;

describe("runcap: no whole-run wall-clock cap by default", () => {
  it("applies no wall-clock cap when agents.defaults.timeoutSeconds is unset", () => {
    // A healthy run that streams for 40 minutes must not be killed at 600s.
    expect(resolveAgentTimeoutMs({})).toBe(NO_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ cfg: {} })).toBe(NO_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ cfg: cfgWith({}) })).toBe(NO_TIMEOUT_MS);
  });

  it("does not resurrect the 600s cloud default for remote providers", () => {
    // The old code returned 600_000 here for any non-local provider.
    expect(resolveAgentTimeoutMs({ provider: "openai" })).not.toBe(600_000);
    expect(resolveAgentTimeoutMs({ cfg: cfgWith({}), provider: "anthropic" })).not.toBe(600_000);
  });

  it("keeps local inference providers uncapped", () => {
    expect(resolveAgentTimeoutMs({ provider: "ollama" })).toBe(NO_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ provider: "vllm" })).toBe(NO_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ provider: "llama.cpp" })).toBe(NO_TIMEOUT_MS);
  });
});

describe("runcap: explicit timeoutSeconds is still honoured (opt-in)", () => {
  it("caps at the configured whole-run timeout", () => {
    expect(resolveAgentTimeoutMs({ cfg: cfgWith({ timeoutSeconds: 120 }) })).toBe(120_000);
    expect(resolveAgentTimeoutMs({ cfg: cfgWith({ timeoutSeconds: 600 }) })).toBe(600_000);
  });

  it("honours per-run overrides over config", () => {
    expect(
      resolveAgentTimeoutMs({ cfg: cfgWith({ timeoutSeconds: 60 }), overrideSeconds: 30 }),
    ).toBe(30_000);
    expect(
      resolveAgentTimeoutMs({ cfg: cfgWith({ timeoutSeconds: 60 }), overrideMs: 45_000 }),
    ).toBe(45_000);
  });

  it("treats an explicit 0 as no cap", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(NO_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(NO_TIMEOUT_MS);
  });

  it("clamps absurd configured values just below the no-limit sentinel (audit A18: still a limit)", () => {
    const ms = resolveAgentTimeoutMs({ cfg: cfgWith({ timeoutSeconds: 9_999_999 }) });
    expect(ms).toBe(NO_TIMEOUT_MS - 1);
    expect(isAgentTimeoutCapped(ms)).toBe(true);
  });

  it("stays capped for explicit limits on both sides of the timer-safe boundary", () => {
    // 2_147_000 s (2_147_000_000 ms) is the first value that exceeds the timer ceiling, so it
    // clamps; 2_146_000 s does not. Either way an explicit limit must remain a limit rather
    // than colliding with the uncapped sentinel.
    for (const seconds of [2_146_000, 2_147_000, 2_200_000, 9_999_999]) {
      const resolved = resolveAgentTimeoutMs({ cfg: cfgWith({ timeoutSeconds: seconds }) });
      expect(isAgentTimeoutCapped(resolved)).toBe(true);
      expect(resolved).not.toBe(NO_TIMEOUT_MS);
    }
  });
});
