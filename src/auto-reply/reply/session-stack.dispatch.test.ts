import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { listStack, stackFilesOf } from "../../infra/session-stack.js";
import { bindStackFiles, writeStackFile } from "../../infra/session-stack.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import type { FollowupRun } from "./queue.js";
import { clearFollowupQueue, enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { clearFollowupDrainCallback } from "./queue/drain.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockFollowupRun } from "./test-helpers.js";

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: async () => ({ handled: false, aborted: false }),
  formatAbortReplyText: () => "aborted",
}));

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

const cfg = {} as OpenClawConfig;

function stackFileCount(): number {
  return listStack().reduce((n, s) => n + s.entries.length, 0);
}

afterEach(() => {
  resetInboundDedupe();
});

describe("session prompt stack at inbound dispatch (§3, §4)", () => {
  async function dispatchWith(
    replyResolver: (ctx: unknown, opts?: GetReplyOptions) => Promise<ReplyPayload | undefined>,
    sid: string,
  ) {
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:stack-test",
      MessageSid: sid,
      Body: `hello ${sid}`,
      SenderId: "sender-1",
    });
    let seenDuringRun: number | undefined;
    const run = dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: (async (c: unknown, o?: GetReplyOptions) => {
        seenDuringRun = stackFileCount();
        return await replyResolver(c, o);
      }) as never,
    });
    return { ctx, run, seen: () => seenDuringRun };
  }

  it("writes the file before the run and deletes it on reply", async () => {
    const { run, seen } = await dispatchWith(async () => ({ text: "ok" }), "m-reply");
    await run;
    expect(seen()).toBe(1);
    expect(stackFileCount()).toBe(0);
  });

  it("stores the received context unchanged", async () => {
    let stored: unknown;
    const { ctx, run } = await dispatchWith(async () => {
      stored = listStack()[0]?.entries[0]?.content;
      return { text: "ok" };
    }, "m-payload");
    await run;
    expect(stored).toEqual({
      source: "inbound",
      payload: { ctx: JSON.parse(JSON.stringify(ctx)) },
    });
  });

  it("deletes the file on error", async () => {
    const { run, seen } = await dispatchWith(async () => {
      throw new Error("boom");
    }, "m-error");
    await expect(run).rejects.toThrow("boom");
    expect(seen()).toBe(1);
    expect(stackFileCount()).toBe(0);
  });

  it("deletes the file on abort", async () => {
    const { run } = await dispatchWith(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }, "m-abort");
    await expect(run).rejects.toThrow("aborted");
    expect(stackFileCount()).toBe(0);
  });
});

describe("session prompt stack in the followup queue (§3)", () => {
  it("a collected turn deletes every prompt it consumed", async () => {
    const key = "agent:main:collect-test";
    const runs: FollowupRun[] = [];
    const items = ["a", "b", "c"].map((prompt) => {
      const item = createMockFollowupRun({ prompt, originatingTo: undefined });
      bindStackFiles(item, [
        writeStackFile({ sessionKey: key, source: "inbound", payload: prompt }),
      ]);
      return item;
    });
    const files = items.flatMap((i) => stackFilesOf(i) ?? []);
    for (const item of items) {
      enqueueFollowupRun(key, item, { mode: "collect", debounceMs: 0 });
    }
    let seenDuringRun = -1;
    const done = new Promise<void>((resolve) => {
      scheduleFollowupDrain(key, async (run) => {
        seenDuringRun = files.filter((f) => fs.existsSync(f)).length;
        runs.push(run);
        resolve();
      });
    });
    await done;
    await vi.waitFor(() => expect(files.filter((f) => fs.existsSync(f))).toEqual([]));
    expect(runs).toHaveLength(1);
    expect(seenDuringRun).toBe(3);
  });

  it("a prompt dropped by queue policy is deleted when dropped", () => {
    const key = "agent:main:drop-test";
    const items = ["a", "b"].map((prompt) => {
      const item = createMockFollowupRun({ prompt, originatingTo: undefined });
      bindStackFiles(item, [
        writeStackFile({ sessionKey: key, source: "inbound", payload: prompt }),
      ]);
      return item;
    });
    const settings = {
      mode: "followup" as const,
      cap: 1,
      dropPolicy: "old" as const,
      debounceMs: 0,
    };
    enqueueFollowupRun(key, items[0], settings);
    enqueueFollowupRun(key, items[1], settings);
    expect(fs.existsSync(stackFilesOf(items[0])?.[0] ?? "")).toBe(false);
  });
});

describe("session prompt stack during restart drain (§6)", () => {
  it("stores the prompt and accepts it without starting a run", async () => {
    const { markGatewayDraining, resetAllLanes } = await import("../../process/command-queue.js");
    markGatewayDraining();
    try {
      const replyResolver = vi.fn(async () => ({ text: "should not run" }));
      const ctx = buildTestCtx({
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:main:drain-test",
        MessageSid: "m-drain",
        Body: "during drain",
      });
      const result = await dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher: createDispatcher(),
        replyResolver: replyResolver as never,
      });
      expect(result.queuedFinal).toBe(false);
      expect(replyResolver).not.toHaveBeenCalled();
      const stored = listStack().find((s) => s.sessionKey === "agent:main:drain-test");
      expect(stored?.entries).toHaveLength(1);
      expect(stored?.entries[0].content.source).toBe("inbound");
    } finally {
      resetAllLanes();
    }
  });
});

describe("session prompt stack: queued prompts during restart drain (§6)", () => {
  it("a queued turn refused by the drain keeps its file for the next start", async () => {
    const { markGatewayDraining, resetAllLanes } = await import("../../process/command-queue.js");
    const key = "agent:main:drain-queue-test";
    const item = createMockFollowupRun({ prompt: "queued", originatingTo: undefined });
    bindStackFiles(item, [writeStackFile({ sessionKey: key, source: "inbound", payload: "q" })]);
    const file = stackFilesOf(item)?.[0] ?? "";
    enqueueFollowupRun(key, item, { mode: "followup", debounceMs: 0 });
    markGatewayDraining();
    try {
      let calls = 0;
      let existedAfterRefusal = false;
      const ran = new Promise<void>((resolve) => {
        scheduleFollowupDrain(key, async () => {
          calls += 1;
          if (calls > 1) {
            // Second attempt: the first refused turn left the item and its file; stop here.
            existedAfterRefusal = fs.existsSync(file);
            clearFollowupQueue(key);
            resolve();
            return;
          }
          throw new Error("Gateway is draining for restart; new tasks are not accepted");
        });
      });
      await ran;
      expect(calls).toBe(2);
      expect(existedAfterRefusal).toBe(true);
    } finally {
      clearFollowupDrainCallback(key);
      resetAllLanes();
      fs.rmSync(file, { force: true });
    }
  });
});
