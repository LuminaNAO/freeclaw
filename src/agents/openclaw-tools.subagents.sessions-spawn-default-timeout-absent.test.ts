import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const MAIN_SESSION_KEY = "agent:test:main";

function configureDefaultsWithoutTimeout() {
  setSessionsSpawnConfigOverride({
    session: { mainKey: "main", scope: "per-sender" },
    agents: { defaults: { subagents: { maxConcurrent: 8 } } },
  });
}

function readSpawnTimeout(calls: Array<{ method?: string; params?: unknown }>): number | undefined {
  const spawn = calls.find((entry) => {
    if (entry.method !== "agent") {
      return false;
    }
    const params = entry.params as { lane?: string } | undefined;
    return params?.lane === "subagent";
  });
  const params = spawn?.params as { timeout?: number } | undefined;
  return params?.timeout;
}

describe("sessions_spawn default runTimeoutSeconds (config absent)", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    getCallGatewayMock().mockClear();
  });

  it("sends no timeout when the subagent key is absent, so the child inherits the run limit", async () => {
    configureDefaultsWithoutTimeout();
    const gateway = setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({ agentSessionKey: MAIN_SESSION_KEY });

    const result = await tool.execute("call-1", { task: "hello" });
    expect(result.details).toMatchObject({ status: "accepted" });
    expect(readSpawnTimeout(gateway.calls)).toBeUndefined();
  });

  it("does not override an explicit global timeoutSeconds with no cap", async () => {
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: { defaults: { timeoutSeconds: 60, subagents: { maxConcurrent: 8 } } },
    });
    const gateway = setupSessionsSpawnGatewayMock({});
    const tool = await getSessionsSpawnTool({ agentSessionKey: MAIN_SESSION_KEY });

    const result = await tool.execute("call-2", { task: "hello" });
    expect(result.details).toMatchObject({ status: "accepted" });
    // Not 0: the gateway "agent" method then resolves agents.defaults.timeoutSeconds (60 s) for the child.
    expect(readSpawnTimeout(gateway.calls)).toBeUndefined();
  });
});
