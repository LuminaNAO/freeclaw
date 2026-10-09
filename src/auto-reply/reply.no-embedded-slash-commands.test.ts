import "./reply.directive.directive-behavior.e2e-mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
  installDirectiveBehaviorE2EHooks,
  makeWhatsAppDirectiveConfig,
  replyTexts,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { runEmbeddedPiAgentMock } from "./reply.directive.directive-behavior.e2e-mocks.js";
import { getReplyFromConfig } from "./reply.js";

// docs/design/no-embedded-slash-commands.md §3.1-§3.3. §3.2 is read as amended by the operator
// (decision A): a leading directive followed by text is stripped and NOT applied (today's behaviour).

const SENDER = {
  From: "+1222",
  To: "+1222",
  Provider: "whatsapp",
  SenderE164: "+1222",
  CommandAuthorized: true,
} as const;

function makeConfig(home: string) {
  return makeWhatsAppDirectiveConfig(home, {
    model: { primary: "anthropic/claude-opus-4-5" },
    models: { "anthropic/claude-opus-4-5": {}, "openai/gpt-4.1-mini": {} },
  });
}

type AgentCall = { prompt?: string; provider?: string; model?: string; thinkLevel?: string };

async function send(home: string, body: string) {
  const blocks: string[] = [];
  const res = await getReplyFromConfig(
    { ...SENDER, Body: body },
    {
      onBlockReply: (payload) => {
        if (payload.text) {
          blocks.push(payload.text);
        }
      },
    },
    makeConfig(home),
  );
  const calls = runEmbeddedPiAgentMock.mock.calls.map((c) => c[0] as AgentCall);
  runEmbeddedPiAgentMock.mockClear();
  return { replies: replyTexts(res), blocks, calls };
}

/** The user's message is the tail of the prompt, after the inbound metadata block. */
function userText(call: AgentCall | undefined): string {
  const prompt = call?.prompt ?? "";
  return prompt.slice(prompt.lastIndexOf("```") + 3).trim();
}

describe("no embedded slash commands", () => {
  installDirectiveBehaviorE2EHooks();

  beforeEach(() => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "model reply" }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    });
  });

  // §3.1
  it.each([
    "hey /status",
    "hey /help",
    "hey /commands",
    "hey /whoami",
    "hey /id",
    "ok /status thanks",
  ])("does not run %s mid-message and passes it to the model unchanged", async (body) => {
    await withTempHome(async (home) => {
      const { replies, blocks, calls } = await send(home, body);
      expect(blocks).toEqual([]);
      expect(replies).toEqual(["model reply"]);
      expect(calls).toHaveLength(1);
      expect(userText(calls[0])).toBe(body);
    });
  });

  // §3.2 first sentence
  it.each([
    "please use /model openai/gpt-4.1-mini for this",
    "please sync /think:high now",
    "quoting /exec security=full and /elevated full here",
    "try /queue interrupt later",
  ])("leaves mid-message directive %s as plain text with no effect", async (body) => {
    await withTempHome(async (home) => {
      const { replies, calls } = await send(home, body);
      expect(replies).toEqual(["model reply"]);
      expect(calls).toHaveLength(1);
      expect(userText(calls[0])).toBe(body);
      expect(calls[0]?.provider).toBe("anthropic");
      expect(calls[0]?.model).toBe("claude-opus-4-5");
      expect(calls[0]?.thinkLevel).not.toBe("high");
      const entry = loadSessionStore(sessionStorePath(home))["agent:main:main"];
      expect(entry?.modelOverride).toBeUndefined();
      expect(entry?.thinkingLevel).toBeUndefined();
      expect(entry?.elevatedLevel).toBeUndefined();
      expect(entry?.execSecurity).toBeUndefined();
      expect(entry?.queueMode).toBeUndefined();
    });
  });

  // §3.2 second sentence, as amended by the operator (decision A)
  it("strips a leading /think from a mixed message without applying it", async () => {
    await withTempHome(async (home) => {
      const baseline = await send(home, "warm up");
      const defaultThink = baseline.calls[0]?.thinkLevel;
      expect(defaultThink).not.toBe("high");

      const { replies, blocks, calls } = await send(home, "/think high do X");
      expect(blocks).toEqual([]);
      expect(replies).toEqual(["model reply"]);
      expect(calls).toHaveLength(1);
      expect(userText(calls[0])).toBe("do X");
      expect(calls[0]?.thinkLevel).toBe(defaultThink);
      const entry = loadSessionStore(sessionStorePath(home))["agent:main:main"];
      expect(entry?.thinkingLevel).toBeUndefined();
    });
  });

  it("strips a leading /model from a mixed message without switching models", async () => {
    await withTempHome(async (home) => {
      const { calls } = await send(home, "/model openai/gpt-4.1-mini then explain this");
      expect(calls).toHaveLength(1);
      expect(userText(calls[0])).toBe("then explain this");
      expect(calls[0]?.model).toBe("claude-opus-4-5");
    });
  });

  it("keeps mid-message tokens after a leading directive as plain text", async () => {
    await withTempHome(async (home) => {
      const { calls } = await send(home, "/think high compare /status with /model");
      expect(calls).toHaveLength(1);
      expect(userText(calls[0])).toBe("compare /status with /model");
    });
  });

  // §3.3
  it("still answers a standalone /status with the status card", async () => {
    await withTempHome(async (home) => {
      const { replies, calls } = await send(home, "/status");
      expect(calls).toHaveLength(0);
      expect(replies.join("\n")).toContain("Model:");
    });
  });

  it("still answers a standalone /help", async () => {
    await withTempHome(async (home) => {
      const { replies, calls } = await send(home, "/help");
      expect(calls).toHaveLength(0);
      expect(replies.join("\n")).toContain("Help");
    });
  });

  it("still runs a leading /help and passes the rest to the model", async () => {
    await withTempHome(async (home) => {
      const { blocks, calls } = await send(home, "/help with something");
      expect(blocks.join("\n")).toContain("Help");
      expect(calls).toHaveLength(1);
      expect(userText(calls[0])).toBe("with something");
    });
  });

  it("still runs a leading /status and passes the rest to the model", async () => {
    await withTempHome(async (home) => {
      const { blocks, calls } = await send(home, "/status then summarise");
      expect(blocks.join("\n")).toContain("Model:");
      expect(calls).toHaveLength(1);
      expect(userText(calls[0])).toBe("then summarise");
    });
  });

  it("still persists a directive-only /think high", async () => {
    await withTempHome(async (home) => {
      const { replies, calls } = await send(home, "/think high");
      expect(calls).toHaveLength(0);
      expect(replies.join("\n")).toContain("Thinking level set to high");
      const entry = loadSessionStore(sessionStorePath(home))["agent:main:main"];
      expect(entry?.thinkingLevel).toBe("high");
    });
  });

  it("still persists a directive-only run of several directives", async () => {
    await withTempHome(async (home) => {
      const { calls } = await send(home, "/verbose on /think low");
      expect(calls).toHaveLength(0);
      const entry = loadSessionStore(sessionStorePath(home))["agent:main:main"];
      expect(entry?.thinkingLevel).toBe("low");
      expect(entry?.verboseLevel).toBe("on");
    });
  });
});

describe("no embedded slash commands: context and wrappers", () => {
  installDirectiveBehaviorE2EHooks();

  beforeEach(() => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "model reply" }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    });
  });

  it("treats a directive in history context as plain text", async () => {
    await withTempHome(async (home) => {
      const body = [
        "[Chat messages since your last reply - for context]",
        "Peter: /thinking high [2025-12-05T21:45:00.000Z]",
        "",
        "[Current message - respond to this]",
        "Give me the status",
      ].join("\n");
      const { replies, calls } = await send(home, body);
      expect(replies).toEqual(["model reply"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.prompt).toContain("Give me the status");
      expect(calls[0]?.thinkLevel).not.toBe("high");
    });
  });

  it("strips a leading directive after a current-message marker without applying it", async () => {
    await withTempHome(async (home) => {
      const body = [
        "[Chat messages since your last reply - for context]",
        "Peter: hello",
        "",
        "[Current message - respond to this]",
        "/think high Give me the status",
      ].join("\n");
      const { calls } = await send(home, body);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.prompt).toContain("Give me the status");
      expect(calls[0]?.prompt).not.toContain("/think high");
      expect(calls[0]?.thinkLevel).not.toBe("high");
    });
  });

  it("does not run a slash command embedded in a heartbeat body", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        { From: "+1003", To: "+1003", Body: "HEARTBEAT /think:high" },
        { isHeartbeat: true },
        makeConfig(home),
      );
      expect(replyTexts(res)).toEqual(["model reply"]);
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    });
  });
});
