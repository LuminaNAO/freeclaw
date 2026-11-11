/**
 * no-reply-tool §8 (runner side): a `no_reply` tool call ends the run silently through the sessions_yield
 * abort path. Mock LLM → agent loop → tool execution → attempt result → run result.
 * Covers §8 tests 1-6, 11, 12 (tool absent without a reply target) and 13.
 */
import fs from "node:fs/promises";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isEmbeddedPiRunActive } from "./pi-embedded-runner/runs.js";
import {
  cleanupEmbeddedPiRunnerTestWorkspace,
  createEmbeddedPiRunnerOpenAiConfig,
  createEmbeddedPiRunnerTestWorkspace,
  type EmbeddedPiRunnerTestWorkspace,
  immediateEnqueue,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";

const toolCalls = vi.hoisted(() => ({
  exec: [] as unknown[],
  message: [] as unknown[],
}));

vi.mock("./bash-tools.js", async () => {
  const actual = await vi.importActual<typeof import("./bash-tools.js")>("./bash-tools.js");
  return {
    ...actual,
    createExecTool: () => ({
      name: "exec",
      label: "exec",
      description: "exec stub",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      execute: async (_id: string, args: unknown) => {
        toolCalls.exec.push(args);
        return { content: [{ type: "text", text: "exec ok" }], details: { status: "completed" } };
      },
    }),
  };
});

vi.mock("./tools/message-tool.js", () => ({
  createMessageTool: () => ({
    name: "message",
    label: "message",
    description: "message stub",
    parameters: {
      type: "object",
      properties: { action: { type: "string" }, message: { type: "string" } },
    },
    execute: async (_id: string, args: unknown) => {
      toolCalls.message.push(args);
      return { content: [{ type: "text", text: '{"ok":true}' }], details: { ok: true } };
    },
  }),
}));

function createMockUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type PlannedBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type PlannedMessage = { content: PlannedBlock[] };

let streamCallCount = 0;
let observedToolNames: string[][] = [];
let observedSystemPrompts: string[] = [];
let plan: PlannedMessage[] = [];

vi.mock("@mariozechner/pi-coding-agent", async () => {
  return await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
});

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  const buildMessage = (
    model: { api: string; provider: string; id: string },
    planned: PlannedMessage,
  ) => {
    const hasToolCall = planned.content.some((block) => block.type === "toolCall");
    return {
      role: "assistant" as const,
      content: planned.content,
      stopReason: hasToolCall ? ("toolUse" as const) : ("stop" as const),
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createMockUsage(1, 1),
      timestamp: Date.now(),
    };
  };
  const next = (model: { api: string; provider: string; id: string }) =>
    buildMessage(model, plan.shift() ?? { content: [{ type: "text", text: "Acknowledged." }] });
  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount++;
      return next(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount++;
      return next(model);
    },
    streamSimple: (
      model: { api: string; provider: string; id: string },
      context: { systemPrompt?: string; tools?: Array<{ name?: string }> },
    ) => {
      streamCallCount++;
      observedToolNames.push((context.tools ?? []).map((tool) => tool.name ?? ""));
      observedSystemPrompts.push(context.systemPrompt ?? "");
      const message = next(model);
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        // Stream the text and tool calls like a provider would, so block streaming sees them.
        stream.push({ type: "start", partial: { ...message, content: [] } });
        const partialContent: PlannedBlock[] = [];
        message.content.forEach((block, contentIndex) => {
          partialContent.push(block);
          const partial = { ...message, content: partialContent.slice() };
          if (block.type === "text") {
            stream.push({ type: "text_start", contentIndex, partial });
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial });
          } else {
            stream.push({ type: "toolcall_start", contentIndex, partial });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
          }
        });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    },
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let e2eWorkspace: EmbeddedPiRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;

beforeAll(async () => {
  vi.useRealTimers();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  e2eWorkspace = await createEmbeddedPiRunnerTestWorkspace("openclaw-no-reply-e2e-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedPiRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

beforeEach(() => {
  streamCallCount = 0;
  observedToolNames = [];
  observedSystemPrompts = [];
  plan = [];
  toolCalls.exec.length = 0;
  toolCalls.message.length = 0;
});

const noReplyCall = (id = "tc-no-reply", reason = "nothing to add"): PlannedBlock => ({
  type: "toolCall",
  id,
  name: "no_reply",
  arguments: { reason },
});

const readSessionMessages = async (sessionFile: string) =>
  (await fs.readFile(sessionFile, "utf-8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message ?? {});

let runCounter = 0;
async function run(params: {
  hasReplyTarget?: boolean;
  messageChannel?: string;
  onBlockReply?: (payload: { text?: string }) => void;
  onSilentReply?: () => void;
  blockStreaming?: "on" | "off";
  blockReplyBreak?: "text_end" | "message_end";
  sessionKey?: string;
  groupId?: string;
  mutateConfig?: (cfg: OpenClawConfig) => void;
}) {
  runCounter += 1;
  const sessionFile = path.join(workspaceDir, `session-no-reply-${runCounter}.jsonl`);
  const sessionId = `no-reply-e2e-${runCounter}`;
  const config = createEmbeddedPiRunnerOpenAiConfig(["mock-no-reply"]);
  params.mutateConfig?.(config);
  const result = await runEmbeddedPiAgent({
    sessionId,
    sessionKey: params.sessionKey ?? `agent:main:signal:group:no-reply-${runCounter}`,
    groupId: params.groupId,
    sessionFile,
    workspaceDir,
    config,
    prompt: "Group chatter that needs no answer.",
    provider: "openai",
    model: "mock-no-reply",
    timeoutMs: 10_000,
    agentDir,
    runId: `run-no-reply-${runCounter}`,
    enqueue: immediateEnqueue,
    hasReplyTarget: params.hasReplyTarget ?? true,
    messageChannel: params.messageChannel ?? "signal",
    senderIsOwner: true,
    onBlockReply: params.onBlockReply,
    onSilentReply: params.onSilentReply,
    blockReplyBreak: params.blockReplyBreak ?? "text_end",
    blockStreaming: params.blockStreaming,
  });
  return { result, sessionFile, sessionId };
}

describe("no_reply e2e", () => {
  it("§8.1 ends the run: no second model call, silent result, transcript keeps the call", async () => {
    plan = [{ content: [noReplyCall()] }];
    const { result, sessionFile, sessionId } = await run({});

    expect(streamCallCount).toBe(1);
    expect(result.silent).toBe(true);
    expect(result.payloads).toBeUndefined();
    expect(result.meta.stopReason).toBe("end_turn");
    expect(result.meta.aborted).toBe(false);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
    expect(observedToolNames[0]).toContain("no_reply");

    // §4.8: the call and its result stay in the transcript for the next turn.
    const messages = await readSessionMessages(sessionFile);
    const calls = messages.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<{ type?: string; name?: string }>) : [],
    );
    expect(calls.some((c) => c.type === "toolCall" && c.name === "no_reply")).toBe(true);
    const toolResult = messages.find((m) => m.role === "toolResult");
    expect(JSON.stringify(toolResult?.content)).toContain('\\"status\\": \\"silent\\"');
    // The synthetic aborted assistant from the yield path is not left behind.
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("§8.2 text in the same assistant message before the call is not delivered", async () => {
    plan = [{ content: [{ type: "text", text: "Here you go, all done." }, noReplyCall()] }];
    const { result } = await run({ blockStreaming: "off" });

    expect(result.silent).toBe(true);
    expect(result.payloads).toBeUndefined();
    expect(streamCallCount).toBe(1);
  });

  it("§8.3 text from an earlier assistant message (before a tool round) is not delivered", async () => {
    plan = [
      {
        content: [
          { type: "text", text: "Let me check that first." },
          { type: "toolCall", id: "tc-exec", name: "exec", arguments: { command: "true" } },
        ],
      },
      { content: [noReplyCall()] },
    ];
    const { result } = await run({ blockStreaming: "off" });

    expect(toolCalls.exec).toHaveLength(1);
    expect(streamCallCount).toBe(2);
    expect(result.silent).toBe(true);
    expect(result.payloads).toBeUndefined();
  });

  it("§8.4 media and reply-tag payloads of the run are not delivered", async () => {
    plan = [
      {
        content: [
          { type: "text", text: "[[reply_to_current]] Look:\nMEDIA:https://example.com/cat.png" },
          noReplyCall(),
        ],
      },
    ];
    const { result } = await run({ blockStreaming: "off" });

    expect(result.silent).toBe(true);
    expect(result.payloads).toBeUndefined();
  });

  it("§8.5 a message-tool send earlier in the run is kept", async () => {
    plan = [
      {
        content: [
          {
            type: "toolCall",
            id: "tc-msg",
            name: "message",
            arguments: { action: "send", message: "Sent to the other group." },
          },
        ],
      },
      { content: [noReplyCall()] },
    ];
    const { result } = await run({});

    expect(toolCalls.message).toEqual([{ action: "send", message: "Sent to the other group." }]);
    expect(result.silent).toBe(true);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["Sent to the other group."]);
    expect(result.payloads).toBeUndefined();
  });

  it("§8.6 block streaming: flushed blocks stay sent, pending blocks are dropped", async () => {
    // message_end break: the second message's text is still buffered when the `no_reply` call streams in.
    plan = [
      {
        content: [
          { type: "text", text: "Checking." },
          { type: "toolCall", id: "tc-exec-1", name: "exec", arguments: { command: "true" } },
        ],
      },
      { content: [{ type: "text", text: "Never mind, nothing to say." }, noReplyCall()] },
    ];
    const blocks: string[] = [];
    let silencedAt = -1;
    const { result } = await run({
      blockStreaming: "on",
      blockReplyBreak: "message_end",
      onBlockReply: (payload) => {
        if (payload.text) {
          blocks.push(payload.text);
        }
      },
      onSilentReply: () => {
        silencedAt = blocks.length;
      },
    });
    // Let fire-and-forget block deliveries settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.silent).toBe(true);
    expect(blocks).toEqual(["Checking."]);
    expect(silencedAt).toBe(1);
    expect(blocks.join("\n")).not.toContain("Never mind");
  });

  it("§8.11 a silent run carries no error or empty-response notice", async () => {
    plan = [{ content: [noReplyCall()] }];
    const { result } = await run({});

    expect(result.silent).toBe(true);
    expect(result.payloads ?? []).toEqual([]);
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.aborted).toBe(false);
  });

  it("§8.12 runs without a reply target are not offered the tool", async () => {
    plan = [{ content: [{ type: "text", text: "Done." }] }];
    const { result } = await run({ hasReplyTarget: false });
    expect(observedToolNames[0]).not.toContain("no_reply");
    expect(observedSystemPrompts[0]).not.toContain("`no_reply`");
    expect(result.payloads?.[0]?.text).toBe("Done.");

    plan = [{ content: [{ type: "text", text: "Done." }] }];
    await run({ sessionKey: "agent:main:subagent:child-1" });
    expect(observedToolNames[1]).not.toContain("no_reply");
  });

  it("§8.13 mixed tool message: exec runs, then the run ends silent (order does not matter)", async () => {
    plan = [
      {
        content: [
          noReplyCall("tc-no-reply-first"),
          { type: "toolCall", id: "tc-exec-2", name: "exec", arguments: { command: "echo hi" } },
        ],
      },
    ];
    const { result, sessionFile } = await run({});

    expect(toolCalls.exec).toEqual([{ command: "echo hi" }]);
    expect(streamCallCount).toBe(1);
    expect(result.silent).toBe(true);
    expect(result.payloads).toBeUndefined();
    const messages = await readSessionMessages(sessionFile);
    expect(messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
  });

  it('§8.7 surface "disallow": tool absent and the prompt has no silence section', async () => {
    plan = [{ content: [{ type: "text", text: "Hi all." }] }];
    const { result } = await run({
      groupId: "group-1",
      mutateConfig: (cfg) => {
        cfg.surfaces = { signal: { silentReply: { group: "disallow" } } };
      },
    });
    expect(observedToolNames[0]).not.toContain("no_reply");
    expect(observedSystemPrompts[0]).not.toMatch(/## Silent replies/i);
    expect(observedSystemPrompts[0]).not.toContain("When you have nothing to say");
    expect(observedSystemPrompts[0]).not.toContain("respond with ONLY: NO_REPLY");
    expect(observedSystemPrompts[0]).not.toContain("`no_reply`");
    expect(result.payloads?.[0]?.text).toBe("Hi all.");
  });

  it("§8.8 model without tools: token prompt, no tool, the token still suppresses", async () => {
    plan = [{ content: [{ type: "text", text: "NO_REPLY" }] }];
    const { result } = await run({
      mutateConfig: (cfg) => {
        const model = cfg.models?.providers?.openai?.models?.[0];
        if (model) {
          model.compat = { supportsTools: false };
        }
      },
    });
    expect(observedToolNames[0]).toEqual([]);
    expect(observedSystemPrompts[0]).toContain("## Silent Replies");
    expect(observedSystemPrompts[0]).toContain(
      "When you have nothing to say, respond with ONLY: NO_REPLY",
    );
    expect(observedSystemPrompts[0]).not.toContain("`no_reply`");
    expect(result.silent).toBeUndefined();
    expect(result.payloads).toBeUndefined();
  });

  it('§8.9 silentReply "token": old behaviour, no tool', async () => {
    for (const mutate of [
      (cfg: OpenClawConfig) => {
        cfg.agents = { defaults: { silentReply: "token" } };
      },
      (cfg: OpenClawConfig) => {
        cfg.agents = { list: [{ id: "main", silentReply: "token" }] };
      },
    ]) {
      observedToolNames = [];
      observedSystemPrompts = [];
      plan = [{ content: [{ type: "text", text: "NO_REPLY" }] }];
      const { result } = await run({ mutateConfig: mutate });
      expect(observedToolNames[0]).not.toContain("no_reply");
      expect(observedToolNames[0]).toContain("exec");
      expect(observedSystemPrompts[0]).toContain(
        "When you have nothing to say, respond with ONLY: NO_REPLY",
      );
      expect(observedSystemPrompts[0]).not.toContain("`no_reply`");
      expect(result.payloads).toBeUndefined();
    }
  });

  it("§8.14 tool mode prompt carries the exact §6 text", async () => {
    plan = [{ content: [noReplyCall()] }];
    await run({});
    expect(observedSystemPrompts[0]).toContain(
      [
        "## Silent replies",
        "When you have nothing to say, call the `no_reply` tool and do nothing else.",
        "- Call it first and alone. Never write text and then call it.",
        '- Never write "NO_REPLY" as text.',
      ].join("\n"),
    );
    expect(observedSystemPrompts[0]).not.toContain("respond with ONLY: NO_REPLY");
  });
});
