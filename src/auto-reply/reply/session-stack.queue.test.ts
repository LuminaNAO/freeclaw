import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { bindStackFiles, listStack, stackFilesOf } from "../../infra/session-stack.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { clearFollowupQueue, getFollowupQueueDepth } from "./queue.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: async () => ({ handled: false, aborted: false }),
  formatAbortReplyText: () => "aborted",
}));
const embedded = vi.hoisted(() => ({
  steer: false,
  waitResults: [] as boolean[],
}));
vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn(() => embedded.steer),
  runEmbeddedPiAgent: vi.fn(async () => ({ payloads: [] })),
  waitForEmbeddedPiRunEnd: vi.fn(async () => embedded.waitResults.shift() ?? true),
}));

const { runReplyAgent } = await import("./agent-runner.js");

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

/** Inbound dispatch whose reply path is the real runReplyAgent with the session busy. */
async function dispatchWhileBusy(params: {
  sessionKey: string;
  sid: string;
  messageId: string;
  queue: QueueSettings;
  isHeartbeat?: boolean;
  steer?: boolean;
}): Promise<string> {
  const ctx = buildTestCtx({
    Provider: "webchat",
    Surface: "webchat",
    SessionKey: params.sessionKey,
    MessageSid: params.sid,
    Body: `prompt ${params.sid}`,
  });
  let file = "";
  await dispatchReplyFromConfig({
    ctx,
    cfg: {} as OpenClawConfig,
    dispatcher: createDispatcher(),
    replyResolver: (async (c: object, opts?: GetReplyOptions) => {
      file = stackFilesOf(c)?.[0] ?? "";
      // Same hand-over as get-reply-run.ts.
      const followupRun: FollowupRun = createMockFollowupRun({
        prompt: `prompt ${params.sid}`,
        messageId: params.messageId,
        originatingTo: undefined,
        run: { sessionKey: params.sessionKey },
      });
      bindStackFiles(followupRun, stackFilesOf(c));
      return await runReplyAgent({
        commandBody: followupRun.prompt,
        followupRun,
        queueKey: params.sessionKey,
        resolvedQueue: params.queue,
        shouldSteer: params.steer === true,
        shouldFollowup: params.steer !== true,
        isActive: true,
        isStreaming: params.steer === true,
        opts,
        typing: createMockTypingController(),
        sessionCtx: { Provider: "webchat" } as TemplateContext,
        defaultModel: "anthropic/claude",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
      });
    }) as never,
    replyOptions: params.isHeartbeat ? { isHeartbeat: true } : undefined,
  });
  return file;
}

describe("session prompt stack: prompts the queue refuses (§3)", () => {
  const queue = { mode: "followup", debounceMs: 60_000 } as QueueSettings;

  it("a queued prompt keeps its file; a deduped repeat of it is deleted", async () => {
    const key = "agent:main:dedupe-test";
    const first = await dispatchWhileBusy({ sessionKey: key, sid: "s1", messageId: "dup", queue });
    expect(getFollowupQueueDepth(key)).toBe(1);
    expect(fs.existsSync(first)).toBe(true);

    const repeat = await dispatchWhileBusy({ sessionKey: key, sid: "s2", messageId: "dup", queue });
    expect(repeat).not.toBe("");
    expect(getFollowupQueueDepth(key)).toBe(1);
    expect(fs.existsSync(repeat)).toBe(false);
    expect(fs.existsSync(first)).toBe(true);
    clearFollowupQueue(key);
    expect(fs.existsSync(first)).toBe(false);
  });

  it("a prompt refused by drop policy new is deleted", async () => {
    const key = "agent:main:drop-new-test";
    const capped = { ...queue, cap: 1, dropPolicy: "new" } as QueueSettings;
    const kept = await dispatchWhileBusy({
      sessionKey: key,
      sid: "n1",
      messageId: "n1",
      queue: capped,
    });
    const refused = await dispatchWhileBusy({
      sessionKey: key,
      sid: "n2",
      messageId: "n2",
      queue: capped,
    });
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(refused)).toBe(false);
    clearFollowupQueue(key);
  });

  it("a prompt dropped by the active-run 'drop' action is deleted", async () => {
    const key = "agent:main:drop-action-test";
    const file = await dispatchWhileBusy({
      sessionKey: key,
      sid: "h1",
      messageId: "h1",
      queue,
      isHeartbeat: true,
    });
    expect(file).not.toBe("");
    expect(fs.existsSync(file)).toBe(false);
    expect(listStack().find((s) => s.sessionKey === key)).toBeUndefined();
  });

  it("a steered prompt stays on disk while its run outlasts the wait, and goes when the run ends", async () => {
    const key = "agent:main:steer-test";
    embedded.steer = true;
    // Two wait timeouts (run still going), then the run ends.
    embedded.waitResults = [false, false, true];
    let release: (() => void) | undefined;
    const ended = new Promise<void>((r) => (release = r));
    const { waitForEmbeddedPiRunEnd } = await import("../../agents/pi-embedded.js");
    vi.mocked(waitForEmbeddedPiRunEnd).mockImplementation(async () => {
      const next = embedded.waitResults.shift() ?? true;
      if (next) {
        await ended;
      }
      return next;
    });
    try {
      const file = await dispatchWhileBusy({
        sessionKey: key,
        sid: "st1",
        messageId: "st1",
        queue,
        steer: true,
      });
      expect(file).not.toBe("");
      await new Promise((r) => setTimeout(r, 20));
      expect(fs.existsSync(file)).toBe(true);
      expect(vi.mocked(waitForEmbeddedPiRunEnd).mock.calls.length).toBeGreaterThanOrEqual(3);
      release?.();
      await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
    } finally {
      embedded.steer = false;
    }
  });
});
