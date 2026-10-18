/**
 * docs/design/agent-peers-and-quiet-sessions.md §3.1 at Telegram ingress: in a
 * `slashCommands: false` session an unauthorized `/…` is ordinary text (not dropped as a control
 * command); unset sessions behave as today. Placeholder ids only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => loadConfigMock() };
});

const { buildTelegramMessageContext } = await import("./bot-message-context.js");

const CHAT_ID = -1001112223334;
let dir: string;
let cfg: Record<string, unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-quiet-"));
  cfg = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: dir } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
    session: { store: path.join(dir, "sessions.json") },
  };
  loadConfigMock.mockReturnValue(cfg);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setSession(slashCommands: false | undefined) {
  const sessionKey = resolveAgentRoute({
    cfg: cfg as never,
    channel: "telegram",
    accountId: "default",
    peer: { kind: "group", id: String(CHAT_ID) },
  }).sessionKey;
  fs.writeFileSync(
    (cfg.session as { store: string }).store,
    JSON.stringify({
      [sessionKey]: {
        sessionId: "s-1",
        updatedAt: Date.now(),
        ...(slashCommands === false ? { slashCommands } : {}),
      },
    }),
  );
  clearSessionStoreCacheForTest();
  return sessionKey;
}

async function build(text: string) {
  return await buildTelegramMessageContext({
    primaryCtx: {
      message: {
        message_id: 5,
        date: 1_700_000_000,
        chat: { id: CHAT_ID, type: "supergroup", title: "Quiet group" },
        text,
        from: { id: 42, first_name: "Member" },
      },
      me: { id: 7, username: "bot" },
    } as never,
    allMedia: [],
    storeAllowFrom: [],
    options: {},
    bot: { api: { sendChatAction: vi.fn(), setMessageReaction: vi.fn() } } as never,
    cfg: cfg as never,
    account: { accountId: "default" } as never,
    historyLimit: 0,
    groupHistories: new Map(),
    dmPolicy: "open",
    allowFrom: [],
    // Command allow-list configured; sender 42 is not on it.
    groupAllowFrom: ["999"],
    ackReactionScope: "off",
    logger: { info: vi.fn() },
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({
      groupConfig: { requireMention: false, groupPolicy: "open" },
      topicConfig: undefined,
    }),
    sendChatActionHandler: { sendChatAction: vi.fn() } as never,
  });
}

describe("telegram ingress (quiet sessions ARCH §3.1)", () => {
  it("unset: an unauthorized group /status is dropped as today", async () => {
    setSession(undefined);
    expect(await build("/status")).toBeNull();
  });

  it("slashCommands: false: /status is ordinary text and reaches dispatch", async () => {
    const sessionKey = setSession(false);
    const ctx = await build("/status");
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload.SessionKey).toBe(sessionKey);
    expect(ctx?.ctxPayload.RawBody).toBe("/status");
  });
});
