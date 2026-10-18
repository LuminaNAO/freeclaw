/**
 * docs/design/agent-peers-and-quiet-sessions.md §3.1 at Matrix ingress: in a `slashCommands: false`
 * session `/…` text is not dropped as an unauthorized control command. Placeholder ids only.
 */
import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeEnv, RuntimeLogger } from "openclaw/plugin-sdk/matrix";
import { describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

const ROOM = "!quiet:example.org";
const SESSION = `agent:main:matrix:channel:${ROOM}`;

async function runRoomCommand(quiet: boolean) {
  const recordInboundSession = vi.fn().mockResolvedValue(undefined);
  const isSlashTextForQuietSession = vi.fn(() => quiet);
  const core = {
    channel: {
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn().mockResolvedValue(undefined),
      },
      routing: {
        buildAgentSessionKey: vi.fn().mockReturnValue(SESSION),
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          accountId: undefined,
          sessionKey: SESSION,
          mainSessionKey: "agent:main:main",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/openclaw-test-session.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(123),
        recordInboundSession,
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockImplementation((p: { body: string }) => p.body),
        formatAgentEnvelope: vi.fn().mockImplementation((p: { body: string }) => p.body),
        finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
        resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
        createReplyDispatcherWithTyping: vi.fn().mockReturnValue({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        }),
        withReplyDispatcher: vi
          .fn()
          .mockResolvedValue({ queuedFinal: false, counts: { final: 0, partial: 0, tool: 0 } }),
      },
      commands: {
        shouldHandleTextCommands: vi.fn().mockReturnValue(true),
        isSlashTextForQuietSession,
      },
      text: {
        hasControlCommand: vi.fn((text: string) => text.trim().startsWith("/")),
        resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
      },
    },
    system: { enqueueSystemEvent: vi.fn() },
  } as unknown as PluginRuntime;
  (core.channel as unknown as Record<string, unknown>).mentions = {
    matchesMentionPatterns: () => false,
  };
  setMatrixRuntime(core);

  const logVerboseMessage = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const handler = createMatrixRoomMessageHandler({
    client: {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.example.org"),
    } as unknown as MatrixClient,
    core,
    // The command owner allow-list is configured and the sender is not on it.
    cfg: {},
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    logger: logger as unknown as RuntimeLogger,
    logVerboseMessage,
    allowFrom: ["@owner:matrix.example.org"],
    // Mention required and not mentioned: past the command gate the message is skipped with a
    // "no-mention" log and recorded as history, which marks "reached mention gating".
    roomsConfig: { [ROOM]: { requireMention: true } },
    mentionRegexes: [],
    groupPolicy: "open",
    replyToMode: "first",
    threadReplies: "inbound",
    dmEnabled: true,
    dmPolicy: "open",
    textLimit: 4000,
    mediaMaxBytes: 5 * 1024 * 1024,
    startupMs: Date.now() - 1_000,
    startupGraceMs: 60_000,
    directTracker: { isDirectMessage: vi.fn().mockResolvedValue(false) },
    getRoomInfo: vi.fn().mockResolvedValue({ name: "Quiet", altAliases: [] }),
    getMemberDisplayName: vi.fn().mockResolvedValue("Member"),
    accountId: undefined,
  });

  await handler(ROOM, {
    type: EventType.RoomMessage,
    event_id: "$quiet1",
    sender: "@member:matrix.example.org",
    origin_server_ts: Date.now(),
    content: { msgtype: "m.text", body: "/status" },
  } as unknown as MatrixRawEvent);
  const reachedMentionGate = logger.info.mock.calls.some(
    (call) => call[0] === "skipping room message",
  );
  const droppedAsCommand = logVerboseMessage.mock.calls.some((call) =>
    String(call[0]).includes("control command (unauthorized)"),
  );
  return { isSlashTextForQuietSession, reachedMentionGate, droppedAsCommand };
}

describe("matrix ingress quiet sessions (ARCH §3.1)", () => {
  it("unset: an unauthorized room /status is dropped as a control command", async () => {
    const result = await runRoomCommand(false);
    expect(result.droppedAsCommand).toBe(true);
    expect(result.reachedMentionGate).toBe(false);
  });

  it("slashCommands: false: /status is ordinary text (no command drop, no mention bypass)", async () => {
    const result = await runRoomCommand(true);
    expect(result.isSlashTextForQuietSession).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/status", sessionKey: SESSION }),
    );
    expect(result.droppedAsCommand).toBe(false);
    expect(result.reachedMentionGate).toBe(true);
  });
});
