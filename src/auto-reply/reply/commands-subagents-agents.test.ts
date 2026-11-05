import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { installSubagentsCommandCoreMocks } from "./commands-subagents.test-mocks.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const sessionBindingCapabilitiesMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  return {
    callGatewayMock,
    readAcpSessionEntryMock,
    sessionBindingCapabilitiesMock,
    sessionBindingBindMock,
    sessionBindingResolveByConversationMock,
    sessionBindingListBySessionMock,
    sessionBindingUnbindMock,
  };
});

function buildSessionBindingService() {
  return {
    touch: vi.fn(),
    listBySession(targetSessionKey: string) {
      return hoisted.sessionBindingListBySessionMock(targetSessionKey);
    },
    resolveByConversation(ref: unknown) {
      return hoisted.sessionBindingResolveByConversationMock(ref);
    },
    getCapabilities(params: unknown) {
      return hoisted.sessionBindingCapabilitiesMock(params);
    },
    bind(input: unknown) {
      return hoisted.sessionBindingBindMock(input);
    },
    unbind(input: unknown) {
      return hoisted.sessionBindingUnbindMock(input);
    },
  };
}

vi.mock("../../gateway/call.js", () => ({
  callGateway: hoisted.callGatewayMock,
}));

vi.mock("../../acp/runtime/session-meta.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../acp/runtime/session-meta.js")>();
  return {
    ...actual,
    readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/session-binding-service.js")>();
  return {
    ...actual,
    getSessionBindingService: () => buildSessionBindingService(),
  };
});

installSubagentsCommandCoreMocks();

const { handleSubagentsCommand } = await import("./commands-subagents.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function createDiscordCommandParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, baseCfg, {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:parent-1",
    AccountId: "default",
    MessageThreadId: "thread-1",
  });
  params.command.senderId = "user-1";
  return params;
}

function createTelegramTopicCommandParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, baseCfg, {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "-100200300:topic:77",
    AccountId: "default",
    MessageThreadId: "77",
  });
  params.command.senderId = "user-1";
  return params;
}

function createSessionBindingRecord(
  overrides?: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:codex-acp:session-1",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      agentId: "codex-acp",
    },
    ...overrides,
  };
}

function createSessionBindingCapabilities() {
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"] as const,
  };
}

describe("/agents; the thread-binding /focus and /unfocus are gone (focus-mode ARCH §7.4)", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.readAcpSessionEntryMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingCapabilitiesMock
      .mockReset()
      .mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);
    hoisted.sessionBindingBindMock.mockReset();
  });

  it("/agents includes active conversation bindings on the current channel/account", async () => {
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test task",
      cleanup: "keep",
      label: "child-1",
      createdAt: Date.now(),
    });

    hoisted.sessionBindingListBySessionMock.mockImplementation((sessionKey: string) => {
      if (sessionKey === "agent:main:subagent:child-1") {
        return [
          createSessionBindingRecord({
            bindingId: "default:thread-1",
            targetSessionKey: sessionKey,
            targetKind: "subagent",
            conversation: {
              channel: "discord",
              accountId: "default",
              conversationId: "thread-1",
            },
          }),
        ];
      }
      if (sessionKey === "agent:main:main") {
        return [
          createSessionBindingRecord({
            bindingId: "default:thread-2",
            targetSessionKey: sessionKey,
            targetKind: "session",
            conversation: {
              channel: "discord",
              accountId: "default",
              conversationId: "thread-2",
            },
            metadata: { label: "main-session" },
          }),
          // Mismatched channel should be filtered.
          createSessionBindingRecord({
            bindingId: "default:tg-1",
            targetSessionKey: sessionKey,
            targetKind: "session",
            conversation: {
              channel: "telegram",
              accountId: "default",
              conversationId: "12345",
            },
          }),
        ];
      }
      return [];
    });

    const result = await handleSubagentsCommand(createDiscordCommandParams("/agents"), true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("agents:");
    expect(text).toContain("thread:thread-1");
    expect(text).toContain("acp/session bindings:");
    expect(text).toContain("session:agent:main:main");
    expect(text).not.toContain("default:tg-1");
  });

  it("/agents keeps finished session-mode runs visible while binding remains", async () => {
    addSubagentRunForTests({
      runId: "run-session-1",
      childSessionKey: "agent:main:subagent:persistent-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent task",
      cleanup: "keep",
      label: "persistent-1",
      spawnMode: "session",
      createdAt: Date.now(),
      endedAt: Date.now(),
    });
    hoisted.sessionBindingListBySessionMock.mockImplementation((sessionKey: string) => {
      if (sessionKey !== "agent:main:subagent:persistent-1") {
        return [];
      }
      return [
        createSessionBindingRecord({
          bindingId: "default:thread-persistent-1",
          targetSessionKey: sessionKey,
          targetKind: "subagent",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: "thread-persistent-1",
          },
        }),
      ];
    });

    const result = await handleSubagentsCommand(createDiscordCommandParams("/agents"), true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("persistent-1");
    expect(text).toContain("thread:thread-persistent-1");
  });

  it("/focus and /unfocus are not thread-binding commands any more", async () => {
    for (const body of ["/focus codex-acp", "/unfocus"]) {
      expect(await handleSubagentsCommand(createDiscordCommandParams(body), true)).toBeNull();
      expect(await handleSubagentsCommand(createTelegramTopicCommandParams(body), true)).toBeNull();
    }
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingUnbindMock).not.toHaveBeenCalled();
  });

  it("/subagents focus|unfocus are gone: the help is shown, nothing is bound", async () => {
    for (const body of ["/subagents focus codex-acp", "/subagents unfocus"]) {
      const text =
        (await handleSubagentsCommand(createDiscordCommandParams(body), true))?.reply?.text ?? "";
      expect(text).toContain("Usage:");
      expect(text).not.toMatch(/\/(?:un)?focus\b/);
    }
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingUnbindMock).not.toHaveBeenCalled();
  });
});
