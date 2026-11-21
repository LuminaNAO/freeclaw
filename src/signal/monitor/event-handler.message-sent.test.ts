import { describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

// model-badge ARCH §2c.14: the reply path hands the turn's session to deliverReplies, so
// the message_sent hook it fires names that session. Placeholders only.

const { dispatchInboundMessageMock } = vi.hoisted(() => ({
  dispatchInboundMessageMock: vi.fn(
    async (params: {
      ctx: { SessionKey?: string };
      dispatcher: {
        sendFinalReply: (p: { text: string }) => boolean;
        waitForIdle(): Promise<void>;
      };
    }) => {
      params.dispatcher.sendFinalReply({ text: "the reply" });
      await params.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    },
  ),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal reply path passes the turn's session to deliverReplies (ARCH §2c.14)", () => {
  it("a group reply is delivered with sessionKey = the group's session", async () => {
    const deliverReplies = vi.fn(async () => {});
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
        deliverReplies,
      }),
    );
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
          attachments: [],
          groupInfo: { groupId: "placeholder-group", groupName: "Placeholder" },
        },
      }),
    );
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    const ctx = dispatchInboundMessageMock.mock.calls[0][0].ctx;
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    const params = (deliverReplies.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.sessionKey).toBe(ctx.SessionKey);
    expect(String(params.sessionKey)).toMatch(/:signal:group:placeholder-group$/);
  });
});
