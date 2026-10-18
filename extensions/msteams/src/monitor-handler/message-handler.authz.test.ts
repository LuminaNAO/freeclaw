import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/msteams";
import { describe, expect, it, vi } from "vitest";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";

describe("msteams monitor handler authz", () => {
  function createDeps(
    cfg: OpenClawConfig,
    quiet?: { hasControlCommand: boolean; isSlashTextForQuietSession: (p: unknown) => boolean },
  ) {
    const readAllowFromStore = vi.fn(async () => ["attacker-aad"]);
    setMSTeamsRuntime({
      logging: { shouldLogVerbose: () => false },
      system: { enqueueSystemEvent: vi.fn() },
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: <T>(params: {
            onFlush: (entries: T[]) => Promise<void>;
          }): { enqueue: (entry: T) => Promise<void> } => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry]);
            },
          }),
        },
        pairing: {
          readAllowFromStore,
          upsertPairingRequest: vi.fn(async () => null),
        },
        text: {
          hasControlCommand: () => quiet?.hasControlCommand ?? false,
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:msteams:group:19:quiet@thread.tacv2",
            mainSessionKey: "agent:main:main",
          }),
        },
        commands: {
          isSlashTextForQuietSession: quiet?.isSlashTextForQuietSession ?? (() => false),
        },
      },
    } as unknown as PluginRuntime);

    const conversationStore = {
      upsert: vi.fn(async () => undefined),
    };

    const deps: MSTeamsMessageHandlerDeps = {
      cfg,
      runtime: { error: vi.fn() } as unknown as RuntimeEnv,
      appId: "test-app",
      adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
      tokenProvider: {
        getAccessToken: vi.fn(async () => "token"),
      },
      textLimit: 4000,
      mediaMaxBytes: 1024 * 1024,
      conversationStore:
        conversationStore as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
      pollStore: {
        recordVote: vi.fn(async () => null),
      } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      } as unknown as MSTeamsMessageHandlerDeps["log"],
    };

    return { conversationStore, deps, readAllowFromStore };
  }

  it("replies with a pairing code to an unknown DM sender", async () => {
    const { conversationStore, deps } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as OpenClawConfig);
    const upsert = vi.fn(async () => ({ code: "ZZTEST42", created: true }));
    const runtime = (await import("../runtime.js")).getMSTeamsRuntime() as unknown as {
      channel: { pairing: { upsertPairingRequest: typeof upsert } };
    };
    runtime.channel.pairing.upsertPairingRequest = upsert;
    const sendActivity = vi.fn(async () => undefined);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-dm-1",
        type: "message",
        text: "hi",
        from: {
          id: "new-user-id",
          aadObjectId: "new-user-aad",
          name: "New User",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "a:dm-conversation",
          conversationType: "personal",
        },
        channelData: {},
        attachments: [],
      },
      sendActivity,
    } as unknown as Parameters<typeof handler>[0]);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(sendActivity).toHaveBeenCalledTimes(1);
    expect(String((sendActivity.mock.calls[0] as unknown[])[0])).toContain("ZZTEST42");
    expect(conversationStore.upsert).not.toHaveBeenCalled();
  });

  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const { conversationStore, deps, readAllowFromStore } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      },
    } as OpenClawConfig);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-1",
        type: "message",
        text: "",
        from: {
          id: "attacker-id",
          aadObjectId: "attacker-aad",
          name: "Attacker",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:group@thread.tacv2",
          conversationType: "groupChat",
        },
        channelData: {},
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "msteams",
      accountId: "default",
    });
    expect(conversationStore.upsert).not.toHaveBeenCalled();
  });

  it("does not widen sender auth when only a teams route allowlist is configured", async () => {
    const { conversationStore, deps } = createDeps({
      channels: {
        msteams: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          teams: {
            team123: {
              channels: {
                "19:group@thread.tacv2": { requireMention: false },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: {
        id: "msg-1",
        type: "message",
        text: "hello",
        from: {
          id: "attacker-id",
          aadObjectId: "attacker-aad",
          name: "Attacker",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:group@thread.tacv2",
          conversationType: "groupChat",
        },
        channelData: {
          team: { id: "team123", name: "Team 123" },
          channel: { name: "General" },
        },
        attachments: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(conversationStore.upsert).not.toHaveBeenCalled();
  });

  describe("quiet sessions (ARCH §3.1)", () => {
    async function runGroupCommand(quiet: boolean) {
      const isSlashTextForQuietSession = vi.fn(() => quiet);
      const { conversationStore, deps } = createDeps(
        {
          channels: {
            msteams: {
              dmPolicy: "pairing",
              allowFrom: ["owner-aad"],
              groupPolicy: "open",
              groupAllowFrom: ["owner-aad"],
            },
          },
        } as OpenClawConfig,
        { hasControlCommand: true, isSlashTextForQuietSession },
      );
      const handler = createMSTeamsMessageHandler(deps);
      await handler({
        activity: {
          id: "msg-quiet-1",
          type: "message",
          text: "/status",
          from: { id: "member-id", aadObjectId: "member-aad", name: "Member" },
          recipient: { id: "bot-id", name: "Bot" },
          conversation: { id: "19:quiet@thread.tacv2", conversationType: "groupChat" },
          channelData: {},
          attachments: [],
        },
        sendActivity: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof handler>[0]);
      return { conversationStore, isSlashTextForQuietSession };
    }

    it("unset: an unauthorized group /status is dropped as a control command", async () => {
      const { conversationStore } = await runGroupCommand(false);
      expect(conversationStore.upsert).not.toHaveBeenCalled();
    });

    it("slashCommands: false: /status is ordinary text and passes the command gate", async () => {
      const { conversationStore, isSlashTextForQuietSession } = await runGroupCommand(true);
      expect(isSlashTextForQuietSession).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "/status",
          sessionKey: "agent:main:msteams:group:19:quiet@thread.tacv2",
        }),
      );
      expect(conversationStore.upsert).toHaveBeenCalled();
    });
  });
});
