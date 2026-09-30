import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  NO_AGENT_TIMEOUT_MS,
  resolveAgentTimeoutMs,
  resolveSubagentRunTimeoutSeconds,
} from "./timeout.js";

const cfg = (defaults: Record<string, unknown>) => ({ agents: { defaults } }) as OpenClawConfig;

describe("subagent run limit", () => {
  it("inherits agents.defaults.timeoutSeconds when no subagent limit is set", () => {
    const config = cfg({ timeoutSeconds: 60 });
    const requested = resolveSubagentRunTimeoutSeconds(config, undefined);
    expect(requested).toBeUndefined();
    // What the child run ends up with (commands/agent.ts / subagent-registry wait).
    expect(resolveAgentTimeoutMs({ cfg: config, overrideSeconds: requested })).toBe(60_000);
  });

  it("stays uncapped when nothing is configured", () => {
    const requested = resolveSubagentRunTimeoutSeconds(cfg({}), undefined);
    expect(resolveAgentTimeoutMs({ cfg: cfg({}), overrideSeconds: requested })).toBe(
      NO_AGENT_TIMEOUT_MS,
    );
  });

  it("prefers the spawn request, then agents.defaults.subagents.runTimeoutSeconds", () => {
    const config = cfg({ timeoutSeconds: 60, subagents: { runTimeoutSeconds: 900 } });
    expect(resolveSubagentRunTimeoutSeconds(config, 300)).toBe(300);
    expect(resolveSubagentRunTimeoutSeconds(config, undefined)).toBe(900);
  });

  it("keeps an explicit 0 as no cap", () => {
    const config = cfg({ timeoutSeconds: 60, subagents: { runTimeoutSeconds: 0 } });
    const requested = resolveSubagentRunTimeoutSeconds(config, undefined);
    expect(requested).toBe(0);
    expect(resolveAgentTimeoutMs({ cfg: config, overrideSeconds: requested })).toBe(
      NO_AGENT_TIMEOUT_MS,
    );
  });
});
