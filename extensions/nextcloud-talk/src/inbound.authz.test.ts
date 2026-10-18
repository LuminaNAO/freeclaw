import type { PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/nextcloud-talk";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

describe("nextcloud-talk inbound authz", () => {
  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const readAllowFromStore = vi.fn(async () => ["attacker"]);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    setNextcloudTalkRuntime({
      channel: {
        pairing: {
          readAllowFromStore,
        },
        commands: {
          shouldHandleTextCommands: () => false,
        },
        text: {
          hasControlCommand: () => false,
        },
        mentions: {
          buildMentionRegexes,
          matchesMentionPatterns: () => false,
        },
      },
    } as unknown as PluginRuntime);

    const message: NextcloudTalkInboundMessage = {
      messageId: "m-1",
      roomToken: "room-1",
      roomName: "Room 1",
      senderId: "attacker",
      senderName: "Attacker",
      text: "hello",
      mediaType: "text/plain",
      timestamp: Date.now(),
      isGroupChat: true,
    };

    const account: ResolvedNextcloudTalkAccount = {
      accountId: "default",
      enabled: true,
      baseUrl: "",
      secret: "",
      secretSource: "none", // pragma: allowlist secret
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
      },
    };

    const config: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      },
    };

    await handleNextcloudTalkInbound({
      message,
      account,
      config,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as RuntimeEnv,
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "nextcloud-talk",
      accountId: "default",
    });
    expect(buildMentionRegexes).not.toHaveBeenCalled();
  });
});

describe("nextcloud-talk quiet sessions (ARCH §3.1)", () => {
  async function runGroupCommand(quiet: boolean) {
    const buildMentionRegexes = vi.fn(() => [] as RegExp[]);
    const isSlashTextForQuietSession = vi.fn(() => quiet);
    setNextcloudTalkRuntime({
      channel: {
        pairing: { readAllowFromStore: vi.fn(async () => []) },
        commands: {
          shouldHandleTextCommands: () => true,
          isSlashTextForQuietSession,
        },
        text: { hasControlCommand: () => true },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:nextcloud-talk:group:room-q",
            mainSessionKey: "agent:main:main",
          }),
        },
        mentions: {
          buildMentionRegexes,
          matchesMentionPatterns: () => false,
        },
      },
    } as unknown as PluginRuntime);
    const account: ResolvedNextcloudTalkAccount = {
      accountId: "default",
      enabled: true,
      baseUrl: "",
      secret: "",
      secretSource: "none", // pragma: allowlist secret
      config: {
        dmPolicy: "pairing",
        allowFrom: ["owner"],
        groupPolicy: "open",
        groupAllowFrom: ["owner"],
        rooms: { "room-q": { requireMention: false } },
      },
    };
    const config: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          dmPolicy: "pairing",
          allowFrom: ["owner"],
          groupPolicy: "open",
          groupAllowFrom: ["owner"],
        },
      },
    };
    // Only ingress classification is asserted; later stages are not stubbed, so the run may
    // reject after the command gate.
    const run = handleNextcloudTalkInbound({
      message: {
        messageId: "m-q",
        roomToken: "room-q",
        roomName: "Quiet",
        senderId: "member",
        senderName: "Member",
        text: "/status",
        mediaType: "text/plain",
        timestamp: Date.now(),
        isGroupChat: true,
      },
      account,
      config,
      runtime: { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv,
    }).catch(() => undefined);
    return { run, buildMentionRegexes, isSlashTextForQuietSession };
  }

  it("unset: an unauthorized group /status is dropped as a control command", async () => {
    const { run, buildMentionRegexes } = await runGroupCommand(false);
    await run;
    expect(buildMentionRegexes).not.toHaveBeenCalled();
  });

  it("slashCommands: false: /status is ordinary text and passes the command gate", async () => {
    const { run, buildMentionRegexes, isSlashTextForQuietSession } = await runGroupCommand(true);
    await run;
    expect(buildMentionRegexes).toHaveBeenCalled();
    expect(isSlashTextForQuietSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:nextcloud-talk:group:room-q" }),
    );
  });
});
