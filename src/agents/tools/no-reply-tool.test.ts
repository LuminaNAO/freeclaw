import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../../auto-reply/heartbeat.js";
import { buildGroupSilenceLine } from "../../auto-reply/silent-reply-wording.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentSilentReplyMode } from "../../config/silent-reply.js";
import {
  applyNoReplyToolWording,
  createNoReplyTool,
  hasNoReplyToolCall,
  NO_REPLY_REASON_MAX_CHARS,
  shouldOfferNoReplyTool,
} from "./no-reply-tool.js";

describe("no_reply tool (no-reply-tool §3)", () => {
  it("has the exact name, label, description and an optional reason", () => {
    const tool = createNoReplyTool({ onNoReply: () => {} });
    expect(tool.name).toBe("no_reply");
    expect(tool.label).toBe("No reply");
    expect(tool.description).toBe(
      "Stay silent: end this turn without sending a reply. Call it alone, as the first and only thing you do, when you have nothing to add. Anything you already sent with the message tool still goes out.",
    );
    const schema = tool.parameters as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["reason"]);
    expect(schema.properties.reason.type).toBe("string");
    expect(schema.required ?? []).toEqual([]);
  });

  it('returns { status: "silent" } and reports the reason, truncated to 200 chars', async () => {
    const onNoReply = vi.fn();
    const tool = createNoReplyTool({ onNoReply });

    const plain = await tool.execute("call-1", {});
    expect(plain.details).toEqual({ status: "silent" });
    expect(onNoReply).toHaveBeenLastCalledWith(undefined);

    const long = "x".repeat(500);
    await tool.execute("call-2", { reason: long });
    expect(onNoReply).toHaveBeenLastCalledWith("x".repeat(NO_REPLY_REASON_MAX_CHARS));
  });

  it("detects a no_reply call in an assistant message", () => {
    expect(
      hasNoReplyToolCall({
        content: [
          { type: "text", text: "hi" },
          { type: "toolCall", name: "no_reply" },
        ],
      }),
    ).toBe(true);
    expect(hasNoReplyToolCall({ content: [{ type: "toolCall", name: " NO_REPLY " }] })).toBe(true);
    expect(hasNoReplyToolCall({ content: [{ type: "toolCall", name: "exec" }] })).toBe(false);
    expect(hasNoReplyToolCall({ content: "no_reply" })).toBe(false);
    expect(hasNoReplyToolCall(undefined)).toBe(false);
  });
});

describe("shouldOfferNoReplyTool (no-reply-tool §5)", () => {
  const base = {
    hasReplyTarget: true,
    surfaceMode: "generic" as const,
    modelSupportsTools: true,
    sessionKey: "agent:main:signal:group:abc",
  };

  it("offers the tool by default in runs with a reply target", () => {
    expect(shouldOfferNoReplyTool(base)).toBe(true);
  });

  it("§5.1: not offered without a reply target or in subagent runs", () => {
    expect(shouldOfferNoReplyTool({ ...base, hasReplyTarget: false })).toBe(false);
    expect(shouldOfferNoReplyTool({ ...base, hasReplyTarget: undefined })).toBe(false);
    expect(shouldOfferNoReplyTool({ ...base, sessionKey: "agent:main:subagent:child-1" })).toBe(
      false,
    );
  });

  it("§5.2: not offered where the surface disallows silence", () => {
    expect(shouldOfferNoReplyTool({ ...base, surfaceMode: "none" })).toBe(false);
  });

  it("§5.3: not offered when the model has no tool support or tools are off", () => {
    expect(shouldOfferNoReplyTool({ ...base, modelSupportsTools: false })).toBe(false);
    expect(shouldOfferNoReplyTool({ ...base, toolsDisabled: true })).toBe(false);
  });

  it('§5.4: "token" mode (default or per agent) offers no tool', () => {
    const defaults = { agents: { defaults: { silentReply: "token" } } } as OpenClawConfig;
    expect(shouldOfferNoReplyTool({ ...base, config: defaults })).toBe(false);

    const perAgent = {
      agents: { defaults: { silentReply: "tool" }, list: [{ id: "quiet", silentReply: "token" }] },
    } as OpenClawConfig;
    expect(shouldOfferNoReplyTool({ ...base, config: perAgent, agentId: "quiet" })).toBe(false);
    expect(shouldOfferNoReplyTool({ ...base, config: perAgent, agentId: "main" })).toBe(true);
  });
});

describe("resolveAgentSilentReplyMode", () => {
  it('defaults to "tool"; agents.list[] overrides agents.defaults', () => {
    expect(resolveAgentSilentReplyMode({})).toBe("tool");
    const cfg = {
      agents: { defaults: { silentReply: "token" }, list: [{ id: "Loud", silentReply: "tool" }] },
    } as OpenClawConfig;
    expect(resolveAgentSilentReplyMode({ cfg })).toBe("token");
    expect(resolveAgentSilentReplyMode({ cfg, agentId: "other" })).toBe("token");
    expect(resolveAgentSilentReplyMode({ cfg, agentId: "loud" })).toBe("tool");
  });
});

describe("applyNoReplyToolWording (no-reply-tool §6)", () => {
  it("rewrites the group intro silence line and the default heartbeat ack sentence", () => {
    const groupLine = buildGroupSilenceLine(SILENT_REPLY_TOKEN);
    const rewritten = applyNoReplyToolWording(`Activation: always-on. ${groupLine} Be selective.`);
    expect(rewritten).not.toContain(SILENT_REPLY_TOKEN);
    expect(rewritten).toContain("call the `no_reply` tool and do nothing else");
    expect(rewritten).toContain("Activation: always-on.");

    const heartbeat = applyNoReplyToolWording(HEARTBEAT_PROMPT);
    expect(heartbeat).not.toContain("HEARTBEAT_OK");
    expect(heartbeat).toContain(
      "If nothing needs attention, call the `no_reply` tool and do nothing else.",
    );
  });

  it("leaves custom text alone", () => {
    expect(applyNoReplyToolWording("Say NO_REPLY when idle.")).toBe("Say NO_REPLY when idle.");
    expect(applyNoReplyToolWording(undefined)).toBeUndefined();
  });
});
