import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { dropThinkingBlocks, isAssistantMessageWithContent } from "./thinking.js";

describe("isAssistantMessageWithContent", () => {
  it("accepts assistant messages with array content and rejects others", () => {
    const assistant = castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    const user = castAgentMessage({ role: "user", content: "hi" });
    const malformed = castAgentMessage({ role: "assistant", content: "not-array" });

    expect(isAssistantMessageWithContent(assistant)).toBe(true);
    expect(isAssistantMessageWithContent(user)).toBe(false);
    expect(isAssistantMessageWithContent(malformed)).toBe(false);
  });
});

describe("dropThinkingBlocks", () => {
  it("returns the original reference when no thinking blocks are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("drops thinking blocks while preserving non-thinking assistant content", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "final" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "final" }]);
  });

  it("keeps assistant turn structure when all content blocks were thinking", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal-only" }],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });

  it("drops text blocks that are leaked Gemma 4 thinking (bare 'thought' label)", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "text", text: "thought\nThe user wants me to call a tool..." },
          { type: "text", text: "Hello! How can I help?" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "Hello! How can I help?" }]);
  });

  it("drops text blocks that are bare Gemma 4 channel closing tags", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "text", text: "<channel|>" },
          { type: "text", text: "actual response" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "actual response" }]);
  });

  it("strips inline channel tags from text blocks with real content", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hello <channel|> world" }],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "Hello  world" }]);
  });

  it("drops leaked thinking with channel closing tag", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "text", text: "thought\nLet me check the error.<channel|>" },
          {
            type: "tool_use",
            id: "abc",
            name: "exec",
            input: { command: "ls" },
          },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([
      { type: "tool_use", id: "abc", name: "exec", input: { command: "ls" } },
    ]);
  });

  it("preserves the original array when no thinking or leaked content exists", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "clean response" }],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });
});
