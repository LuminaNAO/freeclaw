import { describe, expect, it } from "vitest";
import {
  makeAgentAssistantMessage,
  makeAgentToolResultMessage,
  makeAgentUserMessage,
} from "../test-helpers/agent-message-fixtures.js";
import {
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateContextCharsBreakdown,
} from "./tool-result-char-estimator.js";

describe("estimateContextCharsBreakdown", () => {
  it("separates text, thinking, tool content, and details", () => {
    const messages = [
      makeAgentUserMessage({ content: "u".repeat(100) }),
      makeAgentAssistantMessage({
        content: [
          { type: "thinking", thinking: "t".repeat(40) },
          { type: "text", text: "a".repeat(60) },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "x".repeat(30) } },
        ],
      }),
      {
        ...makeAgentToolResultMessage({
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "r".repeat(200) }],
        }),
        details: { content: "d".repeat(80) },
      },
    ] as Parameters<typeof estimateContextChars>[0];

    const cache = createMessageCharEstimateCache();
    const breakdown = estimateContextCharsBreakdown(messages, cache);

    expect(breakdown.textChars).toBe(100 + 60 + JSON.stringify({ path: "x".repeat(30) }).length);
    expect(breakdown.thinkingChars).toBe(40);
    expect(breakdown.toolChars).toBe(200);
    expect(breakdown.detailsChars).toBe(JSON.stringify({ content: "d".repeat(80) }).length);
    expect(breakdown.totalChars).toBe(estimateContextChars(messages, cache));
  });

  it("excludes details from the total and applies no extra tool-result weighting", () => {
    const messages = [
      {
        ...makeAgentToolResultMessage({
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "r".repeat(100) }],
        }),
        details: { content: "d".repeat(50) },
      },
    ] as Parameters<typeof estimateContextChars>[0];

    const cache = createMessageCharEstimateCache();
    const breakdown = estimateContextCharsBreakdown(messages, cache);
    const detailsChars = JSON.stringify({ content: "d".repeat(50) }).length;

    // Wire semantics: content counts once, details never reach the provider.
    expect(breakdown.toolChars).toBe(100);
    expect(breakdown.detailsChars).toBe(detailsChars);
    expect(breakdown.totalChars).toBe(100);
  });

  it("counts thinking only when the cache includes it (provider replays thinking)", () => {
    const messages = [
      makeAgentAssistantMessage({
        content: [
          { type: "thinking", thinking: "t".repeat(120) },
          { type: "text", text: "a".repeat(40) },
        ],
      }),
    ] as Parameters<typeof estimateContextChars>[0];

    const withThinking = estimateContextChars(messages, createMessageCharEstimateCache());
    const withoutThinking = estimateContextChars(
      messages,
      createMessageCharEstimateCache({ includeThinking: false }),
    );

    expect(withThinking).toBe(160);
    expect(withoutThinking).toBe(40);
  });

  it("returns zeros for an empty context", () => {
    const breakdown = estimateContextCharsBreakdown([], createMessageCharEstimateCache());
    expect(breakdown).toEqual({
      textChars: 0,
      thinkingChars: 0,
      toolChars: 0,
      detailsChars: 0,
      totalChars: 0,
    });
  });
});
