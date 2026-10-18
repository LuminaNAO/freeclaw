/**
 * docs/design/agent-peers-and-quiet-sessions.md §2a: the agent `gateway` tool gains
 * signal.trust.markAgent / unmarkAgent and sessions.setQuiet, calling the same gateway methods as
 * the CLI, allowed only when the current turn's sender is an operator.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { applyOwnerOnlyToolPolicy } from "./tool-policy.js";
import { OWNER_ONLY_TOOL_ERROR } from "./tools/common.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const UUID = "00000000-0000-4000-8000-0000000000a1";
const SESSION = "agent:main:signal:group:g1";

function gatewayToolFor(senderIsOwner: boolean | undefined) {
  const tools = createOpenClawTools({
    agentSessionKey: SESSION,
    config: {},
    ...(senderIsOwner === undefined ? {} : { senderIsOwner }),
  });
  const tool = tools.find((candidate) => candidate.name === "gateway");
  if (!tool) {
    throw new Error("missing gateway tool");
  }
  return tool;
}

beforeEach(() => {
  vi.mocked(callGatewayTool).mockClear();
});

describe("gateway tool agent-peer actions (ARCH §2a)", () => {
  it("description states the operator-only rule", () => {
    const tool = gatewayToolFor(true);
    expect(tool.description).toContain(
      "allowed only when the current turn's sender is an operator (senderIsOwner); otherwise they are refused",
    );
  });

  it("calls the very gateway methods the CLI path registers (no parallel implementation)", async () => {
    const { signalTrustHandlers } = await import("../gateway/server-methods/signal-trust.js");
    const { sessionsQuietHandlers } = await import("../gateway/server-methods/sessions-quiet.js");
    const tool = gatewayToolFor(true);
    await tool.execute?.("a", { action: "signal.trust.markAgent", uuid: UUID });
    await tool.execute?.("b", { action: "signal.trust.unmarkAgent", uuid: UUID });
    await tool.execute?.("c", { action: "sessions.setQuiet", slashCommands: false });
    const methods = vi.mocked(callGatewayTool).mock.calls.map((call) => call[0]);
    expect(methods).toEqual([
      "signal.trust.markAgent",
      "signal.trust.unmarkAgent",
      "sessions.setQuiet",
    ]);
    for (const method of methods) {
      expect(signalTrustHandlers[method] ?? sessionsQuietHandlers[method]).toBeTypeOf("function");
    }
  });

  it("lists the new actions in the schema", () => {
    const tool = gatewayToolFor(true);
    const actionEnum = (tool.parameters as { properties: { action: { enum?: string[] } } })
      .properties.action.enum;
    expect(actionEnum).toEqual(
      expect.arrayContaining([
        "signal.trust.markAgent",
        "signal.trust.unmarkAgent",
        "sessions.setQuiet",
      ]),
    );
  });

  it("operator turn: markAgent and unmarkAgent call the same gateway methods as the CLI", async () => {
    const tool = gatewayToolFor(true);
    await tool.execute?.("call-1", { action: "signal.trust.markAgent", uuid: UUID });
    await tool.execute?.("call-2", {
      action: "signal.trust.unmarkAgent",
      uuid: UUID,
      account: "work",
    });
    expect(callGatewayTool).toHaveBeenNthCalledWith(
      1,
      "signal.trust.markAgent",
      expect.any(Object),
      {
        uuid: UUID,
      },
    );
    expect(callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "signal.trust.unmarkAgent",
      expect.any(Object),
      { uuid: UUID, account: "work" },
    );
  });

  it("operator turn: sessions.setQuiet passes only the given settings, defaulting to this session", async () => {
    const tool = gatewayToolFor(true);
    await tool.execute?.("call-1", { action: "sessions.setQuiet", errorReplies: false });
    await tool.execute?.("call-2", {
      action: "sessions.setQuiet",
      sessionKey: "agent:main:main",
      errorReplies: true,
      slashCommands: false,
    });
    expect(callGatewayTool).toHaveBeenNthCalledWith(1, "sessions.setQuiet", expect.any(Object), {
      sessionKey: SESSION,
      errorReplies: false,
    });
    expect(callGatewayTool).toHaveBeenNthCalledWith(2, "sessions.setQuiet", expect.any(Object), {
      sessionKey: "agent:main:main",
      errorReplies: true,
      slashCommands: false,
    });
    await expect(tool.execute?.("call-3", { action: "sessions.setQuiet" })).rejects.toThrow(
      /errorReplies and\/or slashCommands/,
    );
  });

  it("non-operator turn: each action is refused and nothing is called", async () => {
    // Even if the tool were reachable (it is ownerOnly), the actions refuse non-operator turns.
    for (const senderIsOwner of [false, undefined]) {
      const tool = createGatewayTool({ agentSessionKey: SESSION, senderIsOwner });
      for (const args of [
        { action: "signal.trust.markAgent", uuid: UUID },
        { action: "signal.trust.unmarkAgent", uuid: UUID },
        { action: "sessions.setQuiet", errorReplies: false },
      ]) {
        await expect(tool.execute?.("call", args)).rejects.toThrow(OWNER_ONLY_TOOL_ERROR);
      }
    }
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("non-operator turn: the owner-only policy removes the gateway tool entirely", async () => {
    const tools = applyOwnerOnlyToolPolicy(
      createOpenClawTools({ agentSessionKey: SESSION, config: {} }),
      false,
    );
    expect(tools.some((tool) => tool.name === "gateway")).toBe(false);
  });
});
