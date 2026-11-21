import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
/**
 * docs/design/session-context-limit.md §2.1, §1.1, §3.2, §4 through the real dispatch + reply
 * pipeline (embedded runner mocked): `/context limit` set/show/clear, operator-only, k/m forms,
 * below-minimum refusal, survives /new, /reset, compaction and a model switch, `/status` marks it,
 * and the run is handed the session key the limit is read from.
 */
// The harness installs its module mocks when evaluated: keep it the first import.
// oxlint-disable-next-line import/order
import {
  getCompactEmbeddedPiSessionMock,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  mockRunEmbeddedPiAgentOk,
  requireSessionStorePath,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import type { MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

let dispatchReplyFromConfig: typeof import("./reply/dispatch-from-config.js").dispatchReplyFromConfig;
let finalizeInboundContext: typeof import("./reply/inbound-context.js").finalizeInboundContext;
let loadSessionStore: typeof import("../config/sessions.js").loadSessionStore;
let previousFastTestEnv: string | undefined;

beforeAll(async () => {
  ({ loadSessionStore } = await import("../config/sessions.js"));
  previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  ({ dispatchReplyFromConfig } = await import("./reply/dispatch-from-config.js"));
  ({ finalizeInboundContext } = await import("./reply/inbound-context.js"));
});
afterAll(() => {
  if (previousFastTestEnv === undefined) {
    delete process.env.OPENCLAW_TEST_FAST;
  } else {
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  }
});

installTriggerHandlingE2eTestHooks();

const OPERATOR = "+1000";
const MEMBER = "+1002";
const GROUP_KEY = "agent:main:whatsapp:group:limit-g1@g.us";

function makeLimitCfg(home: string): OpenClawConfig {
  const cfg = makeCfg(home);
  cfg.commands = { ownerAllowFrom: [OPERATOR] };
  cfg.channels = {
    whatsapp: { allowFrom: ["*"], groups: { "*": { requireMention: false } } },
  };
  return cfg;
}

async function seedSession(cfg: OpenClawConfig, entry: Partial<SessionEntry>) {
  await fs.writeFile(
    requireSessionStorePath(cfg),
    JSON.stringify({
      [GROUP_KEY]: {
        sessionId: "limit-session",
        updatedAt: Date.now(),
        chatType: "group",
        ...entry,
      },
    }),
  );
}

function readEntry(cfg: OpenClawConfig): SessionEntry | undefined {
  return loadSessionStore(requireSessionStorePath(cfg), { skipCache: true })[GROUP_KEY];
}

function createCapturingDispatcher() {
  const sent: ReplyPayload[] = [];
  const dispatcher: ReplyDispatcher = {
    sendToolResult: (payload) => {
      sent.push(payload);
      return true;
    },
    sendBlockReply: (payload) => {
      sent.push(payload);
      return true;
    },
    sendFinalReply: (payload) => {
      sent.push(payload);
      return true;
    },
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
  };
  return { sent, dispatcher };
}

function groupMessage(body: string, from = MEMBER): MsgContext {
  return {
    Body: body,
    RawBody: body,
    CommandBody: body,
    From: "limit-g1@g.us",
    To: "+2000",
    ChatType: "group",
    Provider: "whatsapp",
    Surface: "whatsapp",
    SenderE164: from,
    SenderId: from,
    SessionKey: GROUP_KEY,
    GroupSubject: "Limit group",
    CommandAuthorized: true,
    WasMentioned: false,
  };
}

async function dispatch(cfg: OpenClawConfig, body: string, from = OPERATOR): Promise<string> {
  const { sent, dispatcher } = createCapturingDispatcher();
  await dispatchReplyFromConfig({
    ctx: finalizeInboundContext({ ...groupMessage(body, from) }),
    cfg,
    dispatcher,
  });
  return sent.map((payload) => payload.text ?? "").join("\n");
}

describe("/context limit (ARCH §2.1)", () => {
  it("operator sets with k and m forms, shows the effective window, and clears with default", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, {});

      let text = await dispatch(cfg, "/context limit 64k");
      expect(text).toContain("Context limit set to 64k (64000 tokens)");
      expect(text).toContain("Effective window: 64k (source: session limit; model 200k)");
      expect(readEntry(cfg)?.contextLimit).toBe(64_000);

      text = await dispatch(cfg, "/context limit 0.1m");
      expect(readEntry(cfg)?.contextLimit).toBe(100_000);

      text = await dispatch(cfg, "/context limit");
      expect(text).toContain("Context limit: 100k (100000 tokens)");
      expect(text).toContain("Effective window: 100k (source: session limit; model 200k)");

      text = await dispatch(cfg, "/context limit default");
      expect(text).toContain("Context limit cleared");
      expect(text).toContain("Effective window: 200k (source: model)");
      expect(readEntry(cfg)?.contextLimit).toBeUndefined();
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });

  it("a limit above the model window is stored but has no effect", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, {});
      const text = await dispatch(cfg, "/context limit 1m");
      expect(readEntry(cfg)?.contextLimit).toBe(1_000_000);
      expect(text).toContain("Effective window: 200k (source: model)");
    });
  });

  it("below the hard minimum is refused with the minimum named; nothing stored", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, { contextLimit: 64_000 });
      const text = await dispatch(cfg, "/context limit 8k");
      expect(text).toContain("at least 16000");
      expect(readEntry(cfg)?.contextLimit).toBe(64_000);
    });
  });

  it("non-operator senders are refused (set, clear and show); nothing changes", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, { contextLimit: 64_000 });
      const cfgWithCommandUsers = {
        ...cfg,
        commands: { ...cfg.commands, allowFrom: { whatsapp: [OPERATOR, MEMBER] } },
      } as OpenClawConfig;
      for (const body of ["/context limit 32k", "/context limit default", "/context limit"]) {
        const text = await dispatch(cfgWithCommandUsers, body, MEMBER);
        expect(text).toBe("⚠️ Only an operator can change this chat's context limit.");
      }
      expect(readEntry(cfg)?.contextLimit).toBe(64_000);
      // A sender without command rights at all: ignored, nothing stored.
      await dispatch(cfg, "/context limit default", MEMBER);
      expect(readEntry(cfg)?.contextLimit).toBe(64_000);
    });
  });
});

describe("the limit belongs to the chat (ARCH §1.1)", () => {
  it("survives /new and /reset", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, { contextLimit: 64_000, contextTokens: 64_000 });
      mockRunEmbeddedPiAgentOk("fresh");
      await dispatch(cfg, "/new");
      let entry = readEntry(cfg);
      expect(entry?.sessionId).not.toBe("limit-session");
      expect(entry?.contextLimit).toBe(64_000);
      const afterNew = entry?.sessionId;
      await dispatch(cfg, "/reset");
      entry = readEntry(cfg);
      expect(entry?.sessionId).not.toBe(afterNew);
      expect(entry?.contextLimit).toBe(64_000);
    });
  });

  it("survives /compact and a model switch", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, { contextLimit: 64_000 });
      getCompactEmbeddedPiSessionMock().mockResolvedValue({
        ok: true,
        compacted: true,
        result: { summary: "s", firstKeptEntryId: "x", tokensBefore: 90_000, tokensAfter: 1_000 },
      });
      await dispatch(cfg, "/compact");
      expect(getCompactEmbeddedPiSessionMock()).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: GROUP_KEY }),
      );
      expect(readEntry(cfg)?.contextLimit).toBe(64_000);

      await dispatch(cfg, "/model openai/gpt-5.2");
      const entry = readEntry(cfg);
      expect(entry?.modelOverride).toBe("gpt-5.2");
      expect(entry?.contextLimit).toBe(64_000);
    });
  });
});

describe("/status and the recorded window (ARCH §3.2, §1.2)", () => {
  it("/status shows the effective window and marks the limit; none without one", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, { totalTokens: 33_000 });
      let text = await dispatch(cfg, "/status");
      expect(text).toContain("Context: 33k/200k");
      expect(text).not.toContain("(limit;");

      await seedSession(cfg, { totalTokens: 33_000, contextLimit: 64_000 });
      text = await dispatch(cfg, "/status");
      expect(text).toContain("Context: 33k/64k (52%) (limit; model 200k)");
    });
  });

  it("a turn records the lowered window and the run gets the chat's session key", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, { contextLimit: 64_000 });
      const run = getRunEmbeddedPiAgentMock();
      run.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "s",
            provider: "anthropic",
            model: "claude-opus-4-5",
            usage: { input: 10, output: 1 },
            lastCallUsage: { input: 10, output: 1 },
          },
        },
      });
      await dispatch(cfg, "hello", MEMBER);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: GROUP_KEY }));
      expect(readEntry(cfg)?.contextTokens).toBe(64_000);
    });
  });

  it("without a limit, a turn records today's window", async () => {
    await withTempHome(async (home) => {
      const cfg = makeLimitCfg(home);
      await seedSession(cfg, {});
      getRunEmbeddedPiAgentMock().mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "s",
            provider: "anthropic",
            model: "claude-opus-4-5",
            usage: { input: 10, output: 1 },
            lastCallUsage: { input: 10, output: 1 },
          },
        },
      });
      await dispatch(cfg, "hello", MEMBER);
      expect(readEntry(cfg)?.contextTokens).toBe(200_000);
    });
  });
});
