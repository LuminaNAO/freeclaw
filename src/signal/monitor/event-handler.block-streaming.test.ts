import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

// Narration follows delivery §2.4 / §3: channels.signal.blockStreaming reaches the reply pipeline as the
// disableBlockStreaming override, which decides the turn's resolved block-streaming state (and so the prompt's
// narration lines; see reply.block-streaming.test.ts for the pipeline side).

const { dispatchInboundMessageMock, capture } = vi.hoisted(() => {
  const captureState: { disableBlockStreaming: boolean | undefined; calls: number } = {
    disableBlockStreaming: undefined,
    calls: 0,
  };
  return {
    dispatchInboundMessageMock: vi.fn(
      async (params: { replyOptions?: { disableBlockStreaming?: boolean } }) => {
        captureState.calls += 1;
        captureState.disableBlockStreaming = params.replyOptions?.disableBlockStreaming;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    ),
    capture: captureState,
  };
});

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

describe("signal blockStreaming reaches the reply pipeline override", () => {
  beforeEach(() => {
    capture.disableBlockStreaming = undefined;
    capture.calls = 0;
    dispatchInboundMessageMock.mockClear();
  });

  for (const [blockStreaming, expected] of [
    [false, true],
    [true, false],
    [undefined, undefined],
  ] as const) {
    it(`blockStreaming=${String(blockStreaming)} -> disableBlockStreaming=${String(expected)}`, async () => {
      const handler = createSignalEventHandler(
        createBaseSignalEventHandlerDeps({
          cfg: {
            messages: { inbound: { debounceMs: 0 } },
            agents: { defaults: { blockStreamingDefault: "on" } },
          },
          blockStreaming,
          historyLimit: 0,
        }),
      );
      await handler(
        createSignalReceiveEvent({
          dataMessage: { message: "hi", attachments: [] },
        }),
      );
      expect(capture.calls).toBe(1);
      expect(capture.disableBlockStreaming).toBe(expected);
    });
  }
});
