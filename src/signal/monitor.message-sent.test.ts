/**
 * model-badge ARCH §2c.14 core prerequisite: Signal's reply path fires the `message_sent`
 * plugin hook after each send, with the turn's `sessionKey`, on success and on a failed
 * send; a throwing or slow hook never breaks, delays or reorders delivery; with no hook
 * registered nothing runs. Placeholders only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({
  sendMessageSignal: (...args: unknown[]) => sendMock(...args),
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
}));

const { deliverReplies } = await import("./monitor.js");

const TARGET = "group:placeholder-group-id";
const SESSION = "agent:main:signal:group:placeholder-group-id";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deliver(texts: string[], extra: { sessionKey?: string; textLimit?: number } = {}) {
  return deliverReplies({
    replies: texts.map((text) => ({ text })),
    target: TARGET,
    baseUrl: "http://127.0.0.1:1",
    accountId: "default",
    sessionKey: "sessionKey" in extra ? extra.sessionKey : SESSION,
    runtime: { log: () => {}, error: () => {}, exit: () => {} } as never,
    maxBytes: 1024,
    textLimit: extra.textLimit ?? 4000,
    chunkMode: "length",
  });
}

function withHook(handler: (...args: unknown[]) => unknown) {
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "message_sent", handler }]));
}

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({ messageId: "1" });
});
afterEach(() => {
  resetGlobalHookRunner();
});

describe("Signal reply path fires message_sent (model-badge ARCH §2c.14)", () => {
  it("success: one event per send, after the send returned, with the turn's sessionKey", async () => {
    const order: string[] = [];
    sendMock.mockImplementation(async (_to: string, text: string) => {
      order.push(`send:${text}`);
      return { messageId: "1" };
    });
    const handler = vi.fn((event: { content: string }) => {
      order.push(`hook:${event.content}`);
    });
    withHook(handler);
    await deliver(["first", "second"]);
    await flush();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(
      1,
      { to: TARGET, content: "first", success: true },
      { channelId: "signal", accountId: "default", conversationId: TARGET, sessionKey: SESSION },
    );
    expect(handler.mock.calls[1]?.[0]).toEqual({ to: TARGET, content: "second", success: true });
    // Each event follows its own send; sends keep their order.
    expect(order.filter((o) => o.startsWith("send:"))).toEqual(["send:first", "send:second"]);
    expect(order.indexOf("hook:first")).toBeGreaterThan(order.indexOf("send:first"));
    expect(order.indexOf("hook:second")).toBeGreaterThan(order.indexOf("send:second"));
  });

  it("a chunked reply fires once per chunk sent", async () => {
    const handler = vi.fn();
    withHook(handler);
    await deliver(["aaaa bbbb cccc"], { textLimit: 5 });
    await flush();
    expect(sendMock.mock.calls.length).toBeGreaterThan(1);
    expect(handler).toHaveBeenCalledTimes(sendMock.mock.calls.length);
    for (const call of handler.mock.calls) {
      expect((call[1] as { sessionKey?: string }).sessionKey).toBe(SESSION);
    }
  });

  it("a failed send fires success:false with the error, and the same error propagates unchanged", async () => {
    const boom = new Error("daemon said no");
    sendMock.mockRejectedValueOnce(boom);
    const handler = vi.fn();
    withHook(handler);
    await expect(deliver(["first", "never sent"])).rejects.toBe(boom);
    await flush();
    // As before: the failing send stops the rest of the replies.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { to: TARGET, content: "first", success: false, error: "daemon said no" },
      { channelId: "signal", accountId: "default", conversationId: TARGET, sessionKey: SESSION },
    );
  });

  it("a non-Error rejection still propagates as the same value", async () => {
    sendMock.mockRejectedValueOnce("plain failure");
    const handler = vi.fn();
    withHook(handler);
    await expect(deliver(["x"])).rejects.toBe("plain failure");
    await flush();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ success: false, error: "plain failure" });
  });

  it("a throwing hook does not break or reorder delivery", async () => {
    const sent: string[] = [];
    sendMock.mockImplementation(async (_to: string, text: string) => {
      sent.push(text);
      return {};
    });
    withHook(() => {
      throw new Error("hook exploded");
    });
    await expect(deliver(["one", "two", "three"])).resolves.toBeUndefined();
    await flush();
    expect(sent).toEqual(["one", "two", "three"]);
    // A rejecting hook too.
    resetGlobalHookRunner();
    withHook(async () => {
      throw new Error("async hook exploded");
    });
    sent.length = 0;
    await expect(deliver(["four", "five"])).resolves.toBeUndefined();
    await flush();
    expect(sent).toEqual(["four", "five"]);
  });

  it("a hook that never settles does not delay delivery", async () => {
    let started = 0;
    withHook(() => {
      started += 1;
      return new Promise(() => {});
    });
    const sent: string[] = [];
    sendMock.mockImplementation(async (_to: string, text: string) => {
      sent.push(text);
      return {};
    });
    await deliver(["one", "two"]);
    expect(sent).toEqual(["one", "two"]);
    await flush();
    expect(started).toBe(2);
  });

  it("the hook does not run synchronously inside the send path", async () => {
    let ran = false;
    withHook(() => {
      ran = true;
    });
    sendMock.mockImplementation(async () => {
      return {};
    });
    const p = deliver(["one"]);
    // Nothing has run before the delivery chain got a chance to continue.
    expect(ran).toBe(false);
    await p;
    await flush();
    expect(ran).toBe(true);
  });

  it("no plugin registered the hook: the runner is never asked to run it", async () => {
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler: vi.fn() }]);
    initializeGlobalHookRunner(registry);
    const { getGlobalHookRunner } = await import("../plugins/hook-runner-global.js");
    const runner = getGlobalHookRunner()!;
    const run = vi.spyOn(runner, "runMessageSent");
    const has = vi.spyOn(runner, "hasHooks");
    await deliver(["one"]);
    await flush();
    expect(has).toHaveBeenCalledWith("message_sent");
    expect(run).not.toHaveBeenCalled();
    // No runner at all (plugins not loaded) is fine too.
    resetGlobalHookRunner();
    await expect(deliver(["two"])).resolves.toBeUndefined();
  });

  it("without a sessionKey the context carries none", async () => {
    const handler = vi.fn();
    withHook(handler);
    await deliver(["one"], { sessionKey: undefined });
    await flush();
    expect(handler.mock.calls[0]?.[1]).toEqual({
      channelId: "signal",
      accountId: "default",
      conversationId: TARGET,
    });
  });
});
