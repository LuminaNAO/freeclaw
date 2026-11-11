import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import { HEARTBEAT_TOKEN } from "../tokens.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

// no-reply-tool §8 (reply-pipeline side): what runReplyAgent does with a run that ended with `no_reply`.

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
  }),
}));

vi.mock("../../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded.js")>(
    "../../agents/pi-embedded.js",
  );
  return {
    ...actual,
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return { ...actual, enqueueFollowupRun: vi.fn(), scheduleFollowupDrain: vi.fn() };
});

import { runReplyAgent } from "./agent-runner.js";

type EmbeddedParams = {
  hasReplyTarget?: boolean;
  onBlockReply?: (payload: { text?: string }) => Promise<void> | void;
  onSilentReply?: () => void;
};

function runAgent(params: {
  isHeartbeat?: boolean;
  blockStreaming?: boolean;
  onBlockReply?: (payload: { text?: string }) => void;
}) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "signal",
    OriginatingTo: "group:abc",
    AccountId: "primary",
    MessageSid: "msg-1",
    ChatType: "group",
  } as unknown as TemplateContext;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "agent:main:signal:group:abc",
      messageProvider: "signal",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {
        agents: {
          defaults: { blockStreamingCoalesce: { minChars: 1, maxChars: 500, idleMs: 60_000 } },
        },
      },
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "text_end",
    },
  } as unknown as FollowupRun;
  return {
    typing,
    result: runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue: { mode: "interrupt" } as unknown as QueueSettings,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      opts: {
        isHeartbeat: params.isHeartbeat,
        onBlockReply: params.onBlockReply,
      },
      typing,
      sessionCtx,
      defaultModel: "anthropic/claude",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: params.blockStreaming === true,
      blockReplyChunking: params.blockStreaming
        ? { minChars: 1, maxChars: 500, breakPreference: "paragraph" }
        : undefined,
      resolvedBlockStreamingBreak: "text_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    }),
  };
}

beforeEach(() => {
  runEmbeddedPiAgentMock.mockReset();
});

describe("runReplyAgent with a silent (no_reply) run", () => {
  it("marks inbound runs as having a reply target (§5.1)", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [{ text: "hi" }], meta: {} });
    await runAgent({}).result;
    const params = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as EmbeddedParams;
    expect(params.hasReplyTarget).toBe(true);
    expect(typeof params.onSilentReply).toBe("function");
  });

  it("delivers nothing and no notice for a silent run (§8.2/§8.11)", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: undefined,
      meta: { durationMs: 1, stopReason: "end_turn" },
      silent: true,
    });
    const { result, typing } = await (async () => {
      const handle = runAgent({});
      return { result: await handle.result, typing: handle.typing };
    })();
    expect(result).toBeUndefined();
    // §4.5: typing stops as for any finished run.
    expect(typing.markRunComplete).toHaveBeenCalled();
  });

  it("§8.10 on a heartbeat, no_reply acts as the ack (same as HEARTBEAT_OK)", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: undefined,
      meta: { durationMs: 1, stopReason: "end_turn" },
      silent: true,
    });
    const result = await runAgent({ isHeartbeat: true }).result;
    expect(result).toEqual({ text: HEARTBEAT_TOKEN });
  });

  it("§8.6 block streaming: blocks sent before the call stay, pending blocks are dropped", async () => {
    const delivered: string[] = [];
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedParams & { onBlockReplyFlush?: () => Promise<void> }) => {
        await params.onBlockReply?.({ text: "First block." });
        // Pre-tool flush: the first block reaches the channel.
        await params.onBlockReplyFlush?.();
        // The coalescer holds this one (idle 60s, below maxChars) until the next flush.
        await params.onBlockReply?.({ text: "Pending block." });
        params.onSilentReply?.();
        await params.onBlockReply?.({ text: "After the call." });
        return { payloads: undefined, meta: { durationMs: 1 }, silent: true };
      },
    );
    const result = await runAgent({
      blockStreaming: true,
      onBlockReply: (payload) => {
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
    }).result;
    expect(result).toBeUndefined();
    expect(delivered).toEqual(["First block."]);
  });
});
