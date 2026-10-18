/**
 * docs/design/agent-peers-and-quiet-sessions.md §3.1 at channel ingress (core channels):
 * in a `slashCommands: false` session, `/…` text is not dropped or intercepted as a control
 * command before dispatch (it reaches the reply pipeline as ordinary text); an operator's
 * `/session` stays a command; unset sessions behave as today. Placeholder ids only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => loadConfigMock() };
});

const { preflightDiscordMessage } = await import("../discord/monitor/message-handler.preflight.js");
const {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
} = await import("../discord/monitor/message-handler.preflight.test-helpers.js");
const { resolveIMessageInboundDecision } =
  await import("../imessage/monitor/inbound-processing.js");
const { prepareSlackMessage } = await import("../slack/monitor/message-handler/prepare.js");
const { createInboundSlackTestContext } =
  await import("../slack/monitor/message-handler/prepare.test-helpers.js");
const { applyGroupGating } = await import("../web/auto-reply/monitor/group-gating.js");

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-ingress-core-"));
  storePath = path.join(dir, "sessions.json");
  fs.writeFileSync(storePath, "{}");
  clearSessionStoreCacheForTest();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setSession(sessionKey: string, slashCommands: false | undefined) {
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [sessionKey]: {
        sessionId: "s-1",
        updatedAt: Date.now(),
        ...(slashCommands === false ? { slashCommands } : {}),
      },
    }),
  );
  clearSessionStoreCacheForTest();
}

function withStore<T extends Record<string, unknown>>(cfg: T): T & OpenClawConfig {
  return { ...cfg, session: { ...(cfg.session as object), store: storePath } } as T &
    OpenClawConfig;
}

describe("discord ingress (ARCH §3.1)", () => {
  const channelId = "c-quiet-1";
  const guildId = "g-quiet-1";
  const cfgBase = { session: { mainKey: "main", scope: "per-sender" } };
  const sessionKey = () =>
    resolveAgentRoute({
      cfg: withStore(cfgBase),
      channel: "discord",
      accountId: "default",
      guildId,
      peer: { kind: "channel", id: channelId },
    }).sessionKey;

  async function preflight(content: string) {
    const cfg = withStore(cfgBase);
    loadConfigMock.mockReturnValue(cfg);
    const author = { id: "u-member", bot: false, username: "member" };
    const message = createDiscordMessage({ id: `m-${content}`, channelId, content, author });
    return await preflightDiscordMessage({
      ...createDiscordPreflightArgs({
        cfg,
        discordConfig: {},
        data: createGuildEvent({ channelId, guildId, author: author as never, message }),
        client: createGuildTextClient(channelId),
      }),
      // Mention not required, so only the control-command intercept decides.
      guildEntries: { [guildId]: { id: guildId, requireMention: false } },
    });
  }

  it("unset: a guild /status is intercepted (dropped) as today", async () => {
    setSession(sessionKey(), undefined);
    expect(await preflight("/status")).toBeNull();
  });

  it("slashCommands: false: a guild /status is ordinary text and is not intercepted", async () => {
    setSession(sessionKey(), false);
    const result = await preflight("/status");
    expect(result).not.toBeNull();
    expect(result?.baseText).toBe("/status");
  });

  it("slashCommands: false: /session still is a command at ingress (intercepted as today)", async () => {
    setSession(sessionKey(), false);
    expect(await preflight("/session slash-commands on")).toBeNull();
  });
});

describe("slack ingress (ARCH §3.1)", () => {
  const sessionKey = () =>
    resolveAgentRoute({
      cfg: withStore({}),
      channel: "slack",
      accountId: "default",
      teamId: "T1",
      peer: { kind: "channel", id: "C1" },
    }).sessionKey;

  async function prepare(text: string) {
    const cfg = withStore({ channels: { slack: { enabled: true } } });
    const ctx = createInboundSlackTestContext({ cfg, defaultRequireMention: false });
    // Command allow-list configured and the sender is not on it.
    (ctx as unknown as { allowFrom: string[]; useAccessGroups: boolean }).allowFrom = ["u-owner"];
    (ctx as unknown as { useAccessGroups: boolean }).useAccessGroups = true;
    // oxlint-disable-next-line typescript/no-explicit-any
    ctx.resolveUserName = async () => ({ name: "Member" }) as any;
    // oxlint-disable-next-line typescript/no-explicit-any
    ctx.resolveChannelName = async () => ({ name: "general", type: "channel" }) as any;
    return await prepareSlackMessage({
      ctx,
      account: { accountId: "default", config: {}, replyToMode: "off" } as never,
      message: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        text,
        user: "U-MEMBER",
        ts: "1700000000.0001",
        event_ts: "1700000000.0001",
      } as never,
      opts: { source: "message" },
    });
  }

  it("unset: an unauthorized /status in a channel is dropped as today", async () => {
    setSession(sessionKey(), undefined);
    expect(await prepare("/status")).toBeNull();
  });

  it("slashCommands: false: /status is ordinary text and reaches dispatch", async () => {
    setSession(sessionKey(), false);
    const result = await prepare("/status");
    expect(result).not.toBeNull();
    expect(result?.ctxPayload.SessionKey).toBe(sessionKey());
  });
});

describe("imessage ingress (ARCH §3.1)", () => {
  const sessionKey = () =>
    resolveAgentRoute({
      cfg: withStore({}),
      channel: "imessage",
      accountId: "default",
      peer: { kind: "group", id: "77" },
    }).sessionKey;

  function decide(text: string) {
    return resolveIMessageInboundDecision({
      cfg: withStore({}),
      accountId: "default",
      message: {
        id: 9,
        sender: "+15550001111",
        text,
        is_from_me: false,
        is_group: true,
        chat_id: 77,
      },
      opts: { requireMention: false },
      messageText: text,
      bodyText: text,
      allowFrom: ["+15550009999"],
      groupAllowFrom: ["+15550009999"],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
    });
  }

  it("unset: an unauthorized group /status is dropped as today", () => {
    setSession(sessionKey(), undefined);
    expect(decide("/status")).toEqual({ kind: "drop", reason: "control command (unauthorized)" });
  });

  it("slashCommands: false: /status is ordinary text and is dispatched", () => {
    setSession(sessionKey(), false);
    expect(decide("/status").kind).toBe("dispatch");
  });
});

describe("whatsapp (web) group gating (ARCH §3.1)", () => {
  const sessionKey = "agent:main:whatsapp:group:quiet@g.us";

  function gate(body: string) {
    const cfg = withStore({
      channels: { whatsapp: { allowFrom: ["+15550000001"] } },
    });
    return applyGroupGating({
      cfg,
      msg: {
        body,
        from: "quiet@g.us",
        conversationId: "quiet@g.us",
        chatType: "group",
        senderE164: "+15550000001",
        selfE164: "+15550000002",
        to: "+15550000002",
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      conversationId: "quiet@g.us",
      groupHistoryKey: "quiet@g.us",
      agentId: "main",
      sessionKey,
      baseMentionConfig: { allowFrom: ["+15550000001"] },
      groupHistories: new Map(),
      groupHistoryLimit: 5,
      groupMemberNames: new Map(),
      logVerbose: () => {},
      replyLogger: { debug: () => {} },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
  }

  it("unset: an owner's /status bypasses mention gating as today", () => {
    setSession(sessionKey, undefined);
    expect(gate("/status").shouldProcess).toBe(true);
  });

  it("slashCommands: false: /status is text, so no mention bypass (stored as history)", () => {
    setSession(sessionKey, false);
    expect(gate("/status").shouldProcess).toBe(false);
  });
});
