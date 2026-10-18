import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
/**
 * docs/design/agent-peers-and-quiet-sessions.md §3 and §4:
 * - `errorReplies: false` -> a failing turn sends nothing to the channel; unset -> notice as today.
 * - `slashCommands: false` -> `/status` arrives as text; operator `/session …` still works;
 *   unset -> commands as today.
 * Drives the real dispatch + reply pipeline with the embedded runner mocked.
 */
// The harness installs its module mocks when evaluated: keep it the first import.
// oxlint-disable-next-line import/order
import {
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
const GROUP_KEY = "agent:main:whatsapp:group:quiet-g1@g.us";

function makeQuietCfg(home: string): OpenClawConfig {
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
        sessionId: "quiet-session",
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
  const sent: Array<{ kind: string; payload: ReplyPayload }> = [];
  const dispatcher: ReplyDispatcher = {
    sendToolResult: (payload) => {
      sent.push({ kind: "tool", payload });
      return true;
    },
    sendBlockReply: (payload) => {
      sent.push({ kind: "block", payload });
      return true;
    },
    sendFinalReply: (payload) => {
      sent.push({ kind: "final", payload });
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
    From: "quiet-g1@g.us",
    To: "+2000",
    ChatType: "group",
    Provider: "whatsapp",
    Surface: "whatsapp",
    SenderE164: from,
    SenderId: from,
    SessionKey: GROUP_KEY,
    GroupSubject: "Quiet group",
    CommandAuthorized: true,
    WasMentioned: false,
  };
}

async function dispatch(cfg: OpenClawConfig, ctx: MsgContext) {
  const { sent, dispatcher } = createCapturingDispatcher();
  await dispatchReplyFromConfig({
    ctx: finalizeInboundContext({ ...ctx }),
    cfg,
    dispatcher,
  });
  return sent;
}

function mockRunFailure() {
  const run = getRunEmbeddedPiAgentMock();
  run.mockReset();
  run.mockRejectedValue(new Error("upstream provider exploded"));
  return run;
}

function mockRunErrorPayload() {
  const run = getRunEmbeddedPiAgentMock();
  run.mockReset();
  run.mockResolvedValue({
    payloads: [{ text: "LLM error: 529 overloaded_error", isError: true }],
    meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
  });
  return run;
}

describe("quiet sessions: errorReplies (ARCH §3.1)", () => {
  it("unset: a failing turn posts the ⚠️ notice as today", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, {});
      mockRunFailure();
      const sent = await dispatch(cfg, groupMessage("hello"));
      const texts = sent.map((entry) => entry.payload.text ?? "");
      expect(texts.some((text) => text.startsWith("⚠️ Agent failed before reply"))).toBe(true);
    });
  });

  it("errorReplies: false: a failing turn sends nothing to the channel; error logged and in status", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, { errorReplies: false });
      const run = mockRunFailure();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const sent = await dispatch(cfg, groupMessage("hello"));
      expect(run).toHaveBeenCalled();
      expect(sent).toEqual([]);
      const entry = readEntry(cfg);
      expect(entry?.errorReplies).toBe(false);
      expect(entry?.lastSuppressedError?.text).toContain("upstream provider exploded");
      errorSpy.mockRestore();
    });
  });

  it("unset: provider error text (isError payload) is posted as today", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, {});
      mockRunErrorPayload();
      const sent = await dispatch(cfg, groupMessage("hello"));
      expect(sent.map((entry) => entry.payload.text)).toContain("LLM error: 529 overloaded_error");
    });
  });

  it("errorReplies: false: provider error text is not posted", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, { errorReplies: false });
      mockRunErrorPayload();
      const sent = await dispatch(cfg, groupMessage("hello"));
      expect(sent).toEqual([]);
      expect(readEntry(cfg)?.lastSuppressedError?.text).toContain("529");
    });
  });

  it("errorReplies: false: successful replies are still posted", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, { errorReplies: false });
      mockRunEmbeddedPiAgentOk("all good");
      const sent = await dispatch(cfg, groupMessage("hello"));
      expect(sent.map((entry) => entry.payload.text)).toContain("all good");
    });
  });
});

describe("quiet sessions: slashCommands (ARCH §3.1)", () => {
  it("unset: /status is a command as today (no model turn)", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, {});
      const run = mockRunEmbeddedPiAgentOk("model reply");
      run.mockClear();
      const sent = await dispatch(cfg, groupMessage("/status", OPERATOR));
      expect(run).not.toHaveBeenCalled();
      expect(sent.some((entry) => (entry.payload.text ?? "").includes("OpenClaw"))).toBe(true);
    });
  });

  it("slashCommands: false: /status arrives at the model as ordinary text", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, { slashCommands: false });
      const run = mockRunEmbeddedPiAgentOk("model reply");
      run.mockClear();
      const sent = await dispatch(cfg, groupMessage("/status", MEMBER));
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]?.prompt ?? "").toContain("/status");
      expect(sent.map((entry) => entry.payload.text)).toEqual(["model reply"]);
    });
  });

  it("slashCommands: false: also for an operator's /status, /new and directives", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, { slashCommands: false });
      const run = mockRunEmbeddedPiAgentOk("model reply");
      for (const body of ["/status", "/new", "/think high explain", "/stop"]) {
        run.mockClear();
        const sent = await dispatch(cfg, groupMessage(body, OPERATOR));
        expect(run, body).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0]?.prompt ?? "", body).toContain(body);
        expect(
          sent.map((entry) => entry.payload.text),
          body,
        ).toEqual(["model reply"]);
      }
      // No reset happened and no thinking override was stored.
      const entry = readEntry(cfg);
      expect(entry?.sessionId).toBe("quiet-session");
      expect(entry?.thinkingLevel).toBeUndefined();
      expect(entry?.slashCommands).toBe(false);
    });
  });

  it("slashCommands: false: operator /session … still works and can undo the setting", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, { slashCommands: false });
      const run = mockRunEmbeddedPiAgentOk("model reply");
      run.mockClear();
      let sent = await dispatch(cfg, groupMessage("/session quiet", OPERATOR));
      expect(run).not.toHaveBeenCalled();
      expect(sent.map((entry) => entry.payload.text).join("\n")).toContain("slashCommands: off");

      sent = await dispatch(cfg, groupMessage("/session slash-commands on", OPERATOR));
      expect(run).not.toHaveBeenCalled();
      expect(sent.map((entry) => entry.payload.text).join("\n")).toContain("✅ Updated session");
      expect(readEntry(cfg)?.slashCommands).toBeUndefined();

      // Commands are back.
      sent = await dispatch(cfg, groupMessage("/status", OPERATOR));
      expect(run).not.toHaveBeenCalled();
      expect(sent.some((entry) => (entry.payload.text ?? "").includes("OpenClaw"))).toBe(true);
    });
  });

  it("slashCommands: false: a non-operator's /session is ordinary text", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, { slashCommands: false });
      const run = mockRunEmbeddedPiAgentOk("model reply");
      run.mockClear();
      const sent = await dispatch(cfg, groupMessage("/session slash-commands on", MEMBER));
      expect(run).toHaveBeenCalledTimes(1);
      expect(sent.map((entry) => entry.payload.text)).toEqual(["model reply"]);
      expect(readEntry(cfg)?.slashCommands).toBe(false);
    });
  });

  it("/session quiet settings are operator-only when commands are on", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, {});
      // A non-operator without command rights: ignored as today.
      let sent = await dispatch(cfg, groupMessage("/session error-replies off", MEMBER));
      expect(readEntry(cfg)?.errorReplies).toBeUndefined();

      // A command-authorized non-operator (commands.allowFrom): refused, nothing stored.
      const cfgWithCommandUsers = {
        ...cfg,
        commands: { ...cfg.commands, allowFrom: { whatsapp: [OPERATOR, MEMBER] } },
      } as OpenClawConfig;
      sent = await dispatch(
        cfgWithCommandUsers,
        groupMessage("/session error-replies off", MEMBER),
      );
      expect(sent.map((entry) => entry.payload.text).join("\n")).toContain("Only an operator");
      expect(readEntry(cfg)?.errorReplies).toBeUndefined();

      const sentOp = await dispatch(cfg, groupMessage("/session error-replies off", OPERATOR));
      expect(sentOp.map((entry) => entry.payload.text).join("\n")).toContain("errorReplies: off");
      expect(readEntry(cfg)?.errorReplies).toBe(false);
    });
  });
});

describe("quiet sessions survive a reset (ARCH §3.2)", () => {
  it("operator /new keeps errorReplies: false", async () => {
    await withTempHome(async (home) => {
      const cfg = makeQuietCfg(home);
      await seedSession(cfg, { errorReplies: false });
      mockRunEmbeddedPiAgentOk("fresh");
      await dispatch(cfg, groupMessage("/new", OPERATOR));
      const entry = readEntry(cfg);
      expect(entry?.sessionId).not.toBe("quiet-session");
      expect(entry?.errorReplies).toBe(false);
    });
  });
});
