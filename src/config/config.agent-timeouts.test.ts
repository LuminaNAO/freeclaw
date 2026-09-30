import { describe, expect, it } from "vitest";
import {
  resolveAgentIdleTimeoutMs,
  resolveAgentTimeoutMs,
  NO_AGENT_TIMEOUT_MS,
} from "../agents/timeout.js";
import { validateConfigObject } from "./config.js";

describe("agents.defaults timeout keys", () => {
  it("accepts timeoutSeconds: 0 and idleTimeoutSeconds: 0 as 'no limit'", () => {
    const res = validateConfigObject({
      agents: { defaults: { timeoutSeconds: 0, idleTimeoutSeconds: 0 } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(resolveAgentTimeoutMs({ cfg: res.config })).toBe(NO_AGENT_TIMEOUT_MS);
    expect(resolveAgentIdleTimeoutMs({ cfg: res.config })).toBe(0);
  });

  it("accepts explicit positive limits", () => {
    const res = validateConfigObject({
      agents: { defaults: { timeoutSeconds: 1800, idleTimeoutSeconds: 300 } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(resolveAgentTimeoutMs({ cfg: res.config })).toBe(1_800_000);
    expect(resolveAgentIdleTimeoutMs({ cfg: res.config })).toBe(300_000);
  });

  it("rejects negative values", () => {
    expect(validateConfigObject({ agents: { defaults: { timeoutSeconds: -1 } } }).ok).toBe(false);
    expect(validateConfigObject({ agents: { defaults: { idleTimeoutSeconds: -5 } } }).ok).toBe(
      false,
    );
  });
});
