import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

// no-reply-tool §4.2/§4.4 at the subscription: the `no_reply` call silences blocks of its own message.

function assistantWith(content: unknown[]) {
  return { role: "assistant", content, stopReason: "toolUse" } as never;
}

function streamMessage(emit: (evt: unknown) => void, text: string, withNoReply: boolean): void {
  const textBlock = { type: "text", text };
  const call = { type: "toolCall", id: "tc-1", name: "no_reply", arguments: {} };
  const textOnly = assistantWith([textBlock]);
  emit({ type: "message_start", message: assistantWith([]) });
  emit({
    type: "message_update",
    message: textOnly,
    assistantMessageEvent: { type: "text_delta", delta: text },
  });
  const full = assistantWith(withNoReply ? [textBlock, call] : [textBlock]);
  if (withNoReply) {
    emit({
      type: "message_update",
      message: full,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
    });
  }
  emit({ type: "message_end", message: full });
}

describe("subscribeEmbeddedPiSession with no_reply", () => {
  it("drops buffered text of the message that calls no_reply and reports the silence once", () => {
    const onBlockReply = vi.fn();
    const onSilentReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-silent",
      onBlockReply,
      onSilentReply,
      silentReplyTool: true,
      blockReplyBreak: "message_end",
    });

    streamMessage(emit, "Sure, here you go.", true);

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onSilentReply).toHaveBeenCalledTimes(1);
    expect(subscription.isSilentReply()).toBe(true);
    expect(subscription.didStreamBlocksBeforeSilence()).toBe(false);
  });

  it("does nothing when the run does not offer the tool", async () => {
    const onBlockReply = vi.fn();
    const onSilentReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-plain",
      onBlockReply,
      onSilentReply,
      blockReplyBreak: "message_end",
    });

    streamMessage(emit, "Sure, here you go.", true);
    await Promise.resolve();
    await Promise.resolve();

    expect(onSilentReply).not.toHaveBeenCalled();
    expect(subscription.isSilentReply()).toBe(false);
    expect(onBlockReply).toHaveBeenCalled();
  });

  it("keeps blocks sent before the call and reports that blocks had streamed", async () => {
    const sent: string[] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-mixed",
      onBlockReply: (payload) => {
        sent.push(payload.text ?? "");
      },
      silentReplyTool: true,
      blockReplyBreak: "message_end",
      blockStreaming: "on",
    });

    streamMessage(emit, "Checking.", false);
    await Promise.resolve();
    await Promise.resolve();
    streamMessage(emit, "Nothing to add after all.", true);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toEqual(["Checking."]);
    expect(subscription.didStreamBlocksBeforeSilence()).toBe(true);
  });
});
