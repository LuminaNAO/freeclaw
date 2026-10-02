import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";

describe("signalPlugin outbound sendMedia", () => {
  it("forwards mediaLocalRoots to sendMessageSignal", async () => {
    const sendSignal = vi.fn(async () => ({ messageId: "m1" }));
    const mediaLocalRoots = ["/tmp/workspace"];

    const sendMedia = signalPlugin.outbound?.sendMedia;
    if (!sendMedia) {
      throw new Error("signal outbound sendMedia is unavailable");
    }

    await sendMedia({
      cfg: {} as never,
      to: "signal:+15551234567",
      text: "photo",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "signal:+15551234567",
      "photo",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots,
        accountId: "default",
      }),
    );
  });
});

describe("signalPlugin setup transport flags", () => {
  const setup = signalPlugin.setup;

  it("rejects --socket-path combined with HTTP flags", () => {
    expect(
      setup?.validateInput?.({ input: { socketPath: "/x/s.sock", httpPort: "8080" } } as never),
    ).toMatch(/cannot be combined/);
  });

  it("HTTP flags write transport=http so the socket default does not ignore them", () => {
    const next = setup?.applyAccountConfig?.({
      cfg: {} as never,
      accountId: "default",
      input: { httpPort: "8080" },
    } as never) as { channels?: { signal?: Record<string, unknown> } };
    expect(next.channels?.signal).toMatchObject({ httpPort: 8080, transport: "http" });
  });

  it("--socket-path writes socketPath without a transport override", () => {
    const next = setup?.applyAccountConfig?.({
      cfg: {} as never,
      accountId: "default",
      input: { socketPath: "/x/s.sock" },
    } as never) as { channels?: { signal?: Record<string, unknown> } };
    expect(next.channels?.signal?.socketPath).toBe("/x/s.sock");
    expect(next.channels?.signal?.transport).toBeUndefined();
  });
});
