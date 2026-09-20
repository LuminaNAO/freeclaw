import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  TOOL_RESULT_PRUNE_CUSTOM_TYPE,
  buildToolResultPrunedPlaceholder,
  installToolResultContextGuard,
  type GuardSessionManagerLike,
} from "./tool-result-context-guard.js";

function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: 0,
  });
}

function makeToolResult(id: string, text: string, toolName = "read"): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  });
}

function makeLegacyToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "tool",
    tool_call_id: id,
    tool_name: "read",
    content: text,
  });
}

function makeToolResultWithDetails(id: string, text: string, detailText: string): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    details: {
      truncation: {
        truncated: true,
        outputLines: 100,
        content: detailText,
      },
    },
    isError: false,
    timestamp: 0,
  });
}

function getToolResultText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

function makeGuardableAgent(
  transformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>,
) {
  return { transformContext };
}

type PruneEntryRecord = {
  customType: string;
  data: { prunedToolUseIds: string[]; boundaryIndex: number; at: number };
};

function makeSessionManagerMock(initialEntries: unknown[] = []) {
  const entries = [...initialEntries];
  return {
    entries,
    getBranch: () => entries.slice(),
    appendCustomEntry: (customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
      return `entry-${entries.length}`;
    },
    pruneEntries: () =>
      entries.filter(
        (e): e is PruneEntryRecord & { type: string } =>
          (e as { type?: string }).type === "custom" &&
          (e as { customType?: string }).customType === TOOL_RESULT_PRUNE_CUSTOM_TYPE,
      ),
  } satisfies GuardSessionManagerLike & {
    entries: unknown[];
    pruneEntries: () => PruneEntryRecord[];
  };
}

async function applyGuard(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  messages: AgentMessage[],
  params?: Partial<Parameters<typeof installToolResultContextGuard>[0]>,
) {
  installToolResultContextGuard({
    agent,
    contextWindowTokens: 1_000,
    ...params,
  });
  return await agent.transformContext?.(messages, new AbortController().signal);
}

describe("installToolResultContextGuard", () => {
  it("leaves an under-trigger context untouched", async () => {
    const agent = makeGuardableAgent();
    const sm = makeSessionManagerMock();
    const messages = [makeUser("u".repeat(200)), makeToolResult("call_a", "x".repeat(400))];
    const before = JSON.stringify(messages);

    await applyGuard(agent, messages, { sessionManager: sm });

    expect(JSON.stringify(messages)).toBe(before);
    expect(sm.pruneEntries()).toHaveLength(0);
  });

  it("truncates an individually oversized tool result with a context-limit notice", async () => {
    const agent = makeGuardableAgent();
    // window 1000 -> single-result cap = 1000 * 4 * 0.5 = 2000 chars.
    const messages = [makeToolResult("call_big", "z".repeat(5_000))];

    await applyGuard(agent, messages);

    const text = getToolResultText(messages[0]);
    expect(text.length).toBeLessThan(2_100);
    expect(text).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("prunes every prunable tool result before the 50% boundary in one event", async () => {
    const agent = makeGuardableAgent();
    const sm = makeSessionManagerMock();
    const onPruneExhausted = vi.fn();
    // window 1000 -> trigger = 3000 chars; total 3900.
    const messages = [
      makeUser("u".repeat(200)),
      makeToolResultWithDetails("call_a", "x".repeat(800), "d".repeat(8_000)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];

    await applyGuard(agent, messages, { sessionManager: sm, onPruneExhausted });

    // 50% boundary of 3900 = 1950 chars; cumulative crosses at call_c (index 3),
    // so call_a and call_b are pruned, call_c and call_d stay raw.
    expect(getToolResultText(messages[1])).toBe(buildToolResultPrunedPlaceholder("read", 800));
    expect(getToolResultText(messages[2])).toBe(buildToolResultPrunedPlaceholder("read", 800));
    expect(getToolResultText(messages[3])).toBe("z".repeat(800));
    expect(getToolResultText(messages[4])).toBe("w".repeat(800));
    // Pruned results drop their (never-on-the-wire) details payloads.
    expect((messages[1] as { details?: unknown }).details).toBeUndefined();

    const entries = sm.pruneEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].data.prunedToolUseIds).toEqual(["call_a", "call_b"]);
    expect(entries[0].data.boundaryIndex).toBe(3);
    expect(onPruneExhausted).not.toHaveBeenCalled();
  });

  it("re-applies persisted prune decisions so two runs of one transcript stay identical", async () => {
    const sm = makeSessionManagerMock();
    const buildMessages = () => [
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];

    const run1Messages = buildMessages();
    await applyGuard(makeGuardableAgent(), run1Messages, { sessionManager: sm });
    expect(sm.pruneEntries()).toHaveLength(1);

    // Second run: the transcript starts raw again (session reloaded from disk),
    // and the persisted entry must reproduce the exact same wire shape.
    const run2Messages = buildMessages();
    await applyGuard(makeGuardableAgent(), run2Messages, { sessionManager: sm });

    expect(JSON.stringify(run2Messages)).toBe(JSON.stringify(run1Messages));
    // Under the trigger after applying persisted prunes: no second prune event.
    expect(sm.pruneEntries()).toHaveLength(1);
  });

  it("records the original byte count when a fresh prune follows truncation, so reloads stay identical", async () => {
    const sm = makeSessionManagerMock();
    // window 2000 -> trigger 6000 chars, single-result cap 4000: call_big is
    // truncated on every run, but its placeholder must carry the ORIGINAL byte
    // count — that is what re-applying the persisted entry derives on reload.
    const buildMessages = () => [
      makeUser("u".repeat(200)),
      makeToolResult("call_big", "z".repeat(9_000)),
      makeToolResult("call_b", "y".repeat(1_400)),
      makeToolResult("call_c", "w".repeat(1_400)),
      makeToolResult("call_d", "v".repeat(1_400)),
      makeUser("q".repeat(300)),
    ];

    const run1Messages = buildMessages();
    await applyGuard(makeGuardableAgent(), run1Messages, {
      sessionManager: sm,
      contextWindowTokens: 2_000,
    });
    expect(sm.pruneEntries()).toHaveLength(1);
    expect(getToolResultText(run1Messages[1])).toBe(
      buildToolResultPrunedPlaceholder("read", 9_000),
    );

    // Reload: raw transcript again, persisted entry re-applied.
    const run2Messages = buildMessages();
    await applyGuard(makeGuardableAgent(), run2Messages, {
      sessionManager: sm,
      contextWindowTokens: 2_000,
    });

    expect(JSON.stringify(run2Messages)).toBe(JSON.stringify(run1Messages));
    // Persisted prune brought the reload under the trigger: no new event.
    expect(sm.pruneEntries()).toHaveLength(1);
  });

  it("skips the prune mutation entirely when persisting the entry fails", async () => {
    // If the entry never lands, a reload would rebuild the prompt from raw
    // results and diverge from this run — so a persistence failure must leave
    // the context untouched instead of pruning without a record.
    const failingSm = {
      getBranch: () => [] as unknown[],
      appendCustomEntry: (): string => {
        throw new Error("disk full");
      },
    };
    const messages = [
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];
    const before = JSON.stringify(messages);

    await applyGuard(makeGuardableAgent(), messages, { sessionManager: failingSm });

    expect(JSON.stringify(messages)).toBe(before);
  });

  it("recovers and prunes on a later call after a transient persistence failure", async () => {
    let fail = true;
    const entries: unknown[] = [];
    const sm = {
      getBranch: () => entries.slice(),
      appendCustomEntry: (customType: string, data?: unknown): string => {
        if (fail) {
          throw new Error("disk full");
        }
        entries.push({ type: "custom", customType, data });
        return `entry-${entries.length}`;
      },
    };
    const messages = [
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];
    const agent = makeGuardableAgent();
    installToolResultContextGuard({ agent, contextWindowTokens: 1_000, sessionManager: sm });

    // First call: persistence fails, context must stay raw.
    await agent.transformContext?.(messages, new AbortController().signal);
    expect(getToolResultText(messages[1])).toBe("x".repeat(800));

    // Transient failure clears: the guard is still armed and retries.
    fail = false;
    await agent.transformContext?.(messages, new AbortController().signal);
    expect(getToolResultText(messages[1])).toBe(buildToolResultPrunedPlaceholder("read", 800));
    expect(getToolResultText(messages[2])).toBe(buildToolResultPrunedPlaceholder("read", 800));
    expect(
      entries.filter(
        (e) => (e as { customType?: string }).customType === TOOL_RESULT_PRUNE_CUSTOM_TYPE,
      ),
    ).toHaveLength(1);
  });

  it("ignores prune entries superseded by a later compaction entry", async () => {
    const sm = makeSessionManagerMock([
      {
        type: "custom",
        customType: TOOL_RESULT_PRUNE_CUSTOM_TYPE,
        data: { prunedToolUseIds: ["call_a", "call_b"], boundaryIndex: 3, at: 1 },
      },
      { type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 1 },
    ]);
    const messages = [
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];

    await applyGuard(makeGuardableAgent(), messages, { sessionManager: sm });

    // The stale entry was superseded, so the guard re-evaluated the raw
    // transcript and persisted a fresh prune event instead of trusting the
    // old entry (which would have left the estimate under the trigger).
    expect(sm.pruneEntries()).toHaveLength(2);
  });

  it("never prunes tool results before the first user message", async () => {
    const agent = makeGuardableAgent();
    const sm = makeSessionManagerMock();
    const messages = [
      makeToolResult("call_bootstrap", "b".repeat(1_000)),
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(200)),
    ];

    await applyGuard(agent, messages, { sessionManager: sm });

    expect(getToolResultText(messages[0])).toBe("b".repeat(1_000));
    expect(getToolResultText(messages[2])).toBe(buildToolResultPrunedPlaceholder("read", 800));
  });

  it("prunes nothing with no user message in the transcript", async () => {
    const agent = makeGuardableAgent();
    const onPruneExhausted = vi.fn();
    const messages = [
      makeToolResult("call_a", "x".repeat(2_000)),
      makeToolResult("call_b", "y".repeat(2_000)),
    ];

    await applyGuard(agent, messages, { onPruneExhausted });

    expect(getToolResultText(messages[0])).toBe("x".repeat(2_000));
    expect(getToolResultText(messages[1])).toBe("y".repeat(2_000));
    expect(onPruneExhausted).toHaveBeenCalledTimes(1);
  });

  it("respects the tools deny list and escalates when nothing is prunable", async () => {
    const agent = makeGuardableAgent();
    const sm = makeSessionManagerMock();
    const onPruneExhausted = vi.fn();
    const messages = [
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];

    await applyGuard(agent, messages, {
      sessionManager: sm,
      onPruneExhausted,
      isToolPrunable: (name) => name !== "read",
    });

    expect(getToolResultText(messages[1])).toBe("x".repeat(800));
    expect(sm.pruneEntries()).toHaveLength(0);
    expect(onPruneExhausted).toHaveBeenCalledTimes(1);
  });

  it("signals exhaustion at most once per install", async () => {
    const agent = makeGuardableAgent();
    const onPruneExhausted = vi.fn();
    const messages = [
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];
    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
      onPruneExhausted,
      isToolPrunable: () => false,
    });

    const signal = new AbortController().signal;
    await agent.transformContext?.(messages, signal);
    await agent.transformContext?.(messages, signal);

    expect(onPruneExhausted).toHaveBeenCalledTimes(1);
  });

  it("escalates when a full prune event cannot get back under the trigger", async () => {
    const agent = makeGuardableAgent();
    const sm = makeSessionManagerMock();
    const onPruneExhausted = vi.fn();
    // total 4400; the 50% boundary frees only ~1.3k, leaving the post-prune
    // estimate still over the 3000 trigger.
    const messages = [
      makeUser("u".repeat(200)),
      ...Array.from({ length: 8 }, (_, i) => makeToolResult(`call_${i}`, "x".repeat(500))),
      makeUser("v".repeat(200)),
    ];

    await applyGuard(agent, messages, { sessionManager: sm, onPruneExhausted });

    expect(sm.pruneEntries().length).toBeGreaterThan(0);
    expect(onPruneExhausted).toHaveBeenCalledTimes(1);
  });

  it("fires a second prune event when the estimate crosses the trigger again", async () => {
    const agent = makeGuardableAgent();
    const sm = makeSessionManagerMock();
    const messages = [
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];
    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
      sessionManager: sm,
    });
    const signal = new AbortController().signal;

    await agent.transformContext?.(messages, signal);
    expect(sm.pruneEntries()).toHaveLength(1);

    // The session keeps growing past the trigger again: a fresh event prunes
    // the results that were behind the first boundary.
    messages.push(
      makeUser("q".repeat(400)),
      makeToolResult("call_e", "e".repeat(800)),
      makeToolResult("call_f", "f".repeat(800)),
    );
    await agent.transformContext?.(messages, signal);

    const entries = sm.pruneEntries();
    expect(entries).toHaveLength(2);
    expect(entries[1].data.prunedToolUseIds).toEqual(["call_c", "call_d"]);
    expect(getToolResultText(messages[7])).toBe("e".repeat(800));
    expect(getToolResultText(messages[8])).toBe("f".repeat(800));
  });

  it("handles legacy role=tool results with tool_call_id", async () => {
    const agent = makeGuardableAgent();
    const sm = makeSessionManagerMock();
    const messages = [
      makeUser("u".repeat(200)),
      makeLegacyToolResult("call_old", "x".repeat(800)),
      makeLegacyToolResult("call_new", "y".repeat(800)),
      makeLegacyToolResult("call_c", "z".repeat(800)),
      makeLegacyToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];

    await applyGuard(agent, messages, { sessionManager: sm });

    expect((messages[1] as { content?: unknown }).content).toBe(
      buildToolResultPrunedPlaceholder("read", 800),
    );
    expect(sm.pruneEntries()[0].data.prunedToolUseIds).toEqual(["call_old", "call_new"]);
  });

  it("skips tool results without a tool id (they cannot be persisted)", async () => {
    const agent = makeGuardableAgent();
    const sm = makeSessionManagerMock();
    const messages = [
      makeUser("u".repeat(200)),
      castAgentMessage({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "n".repeat(800) }],
        isError: false,
        timestamp: 0,
      }),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];

    await applyGuard(agent, messages, { sessionManager: sm });

    // The id-less result stays raw; the id-bearing one before the boundary prunes.
    expect(getToolResultText(messages[1])).toBe("n".repeat(800));
    expect(getToolResultText(messages[2])).toBe(buildToolResultPrunedPlaceholder("read", 800));
    expect(sm.pruneEntries()[0]?.data.prunedToolUseIds).toEqual(["call_b"]);
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) =>
      messages.map((msg) => castAgentMessage({ ...(msg as unknown as Record<string, unknown>) })),
    );
    const messages = [
      makeUser("u".repeat(200)),
      makeToolResult("call_a", "x".repeat(800)),
      makeToolResult("call_b", "y".repeat(800)),
      makeToolResult("call_c", "z".repeat(800)),
      makeToolResult("call_d", "w".repeat(800)),
      makeUser("v".repeat(300)),
    ];

    const transformed = await applyGuard(agent, messages);

    expect(transformed).not.toBe(messages);
    const out = transformed as AgentMessage[];
    expect(getToolResultText(out[1])).toBe(buildToolResultPrunedPlaceholder("read", 800));
    expect(getToolResultText(out[3])).toBe("z".repeat(800));
  });
});
