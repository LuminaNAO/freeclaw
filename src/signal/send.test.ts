import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageSignal } from "./send.js";

const rpcMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
}));

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "default",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

describe("sendMessageSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOutboundAttachmentFromUrlMock.mockResolvedValue({
      path: "/tmp/openclaw-qwen-note.mp3",
      contentType: "audio/mpeg",
    });
    rpcMock.mockResolvedValue({ timestamp: 123 });
  });

  it("sends audio media as a Signal attachment", async () => {
    const result = await sendMessageSignal("+15551234567", "", {
      mediaUrl: "/tmp/openclaw-qwen-note.mp3",
      mediaLocalRoots: ["/tmp"],
      maxBytes: 1024 * 1024,
    });

    expect(result).toEqual({ messageId: "123", timestamp: 123 });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledWith(
      "/tmp/openclaw-qwen-note.mp3",
      1024 * 1024,
      { localRoots: ["/tmp"] },
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        account: "+15550001111",
        attachments: ["/tmp/openclaw-qwen-note.mp3"],
        message: "",
        recipient: ["+15551234567"],
      }),
      expect.objectContaining({ baseUrl: "http://signal.local" }),
    );
  });

  it("never sends a <media:kind> placeholder as the body of our own media (voice ARCH §2.2)", async () => {
    for (const contentType of ["audio/mpeg", "image/png", "video/mp4", "application/pdf"]) {
      resolveOutboundAttachmentFromUrlMock.mockResolvedValueOnce({
        path: "/tmp/outbound-file",
        contentType,
      });
      await sendMessageSignal("+15551234567", "", { mediaUrl: "/tmp/outbound-file" });
      const params = rpcMock.mock.lastCall?.[1] as Record<string, unknown>;
      expect(params.message, contentType).toBe("");
      expect(params.attachments).toEqual(["/tmp/outbound-file"]);
      expect(params["text-style"]).toBeUndefined();
      expect(params.voiceNote).toBeUndefined();
    }
  });

  it("still rejects a send with neither text nor media", async () => {
    await expect(sendMessageSignal("+15551234567", "")).rejects.toThrow(
      "Signal send requires text or media",
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("sends voice-note audio with the voiceNote RPC param and the transcript body (voice ARCH §2.3)", async () => {
    resolveOutboundAttachmentFromUrlMock.mockResolvedValueOnce({
      path: "/tmp/voice.opus",
      contentType: "audio/ogg; codecs=opus",
    });
    await sendMessageSignal("+15551234567", "Hello from the agent", {
      mediaUrl: "/tmp/voice.opus",
      voiceNote: true,
    });
    expect(rpcMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        attachments: ["/tmp/voice.opus"],
        message: "Hello from the agent",
        voiceNote: true,
      }),
      expect.anything(),
    );
  });

  it("leaves the RPC unchanged without the voice flag, and never flags non-audio", async () => {
    resolveOutboundAttachmentFromUrlMock.mockResolvedValueOnce({
      path: "/tmp/voice.opus",
      contentType: "audio/ogg",
    });
    await sendMessageSignal("+15551234567", "caption", { mediaUrl: "/tmp/voice.opus" });
    expect(rpcMock.mock.lastCall?.[1]).not.toHaveProperty("voiceNote");

    resolveOutboundAttachmentFromUrlMock.mockResolvedValueOnce({
      path: "/tmp/photo.png",
      contentType: "image/png",
    });
    await sendMessageSignal("+15551234567", "caption", {
      mediaUrl: "/tmp/photo.png",
      voiceNote: true,
    });
    expect(rpcMock.mock.lastCall?.[1]).not.toHaveProperty("voiceNote");

    await sendMessageSignal("+15551234567", "text only", { voiceNote: true });
    expect(rpcMock.mock.lastCall?.[1]).not.toHaveProperty("voiceNote");
  });

  it("sends to the bare uuid for uuid:<uuid> targets (uuid ARCH §2.2)", async () => {
    await sendMessageSignal("uuid:00000000-0000-4000-8000-00000000000a", "hi");
    expect(rpcMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ recipient: ["00000000-0000-4000-8000-00000000000a"] }),
      expect.anything(),
    );
    await sendMessageSignal("signal:uuid:00000000-0000-4000-8000-00000000000b", "hi");
    expect(rpcMock).toHaveBeenLastCalledWith(
      "send",
      expect.objectContaining({ recipient: ["00000000-0000-4000-8000-00000000000b"] }),
      expect.anything(),
    );
  });
});
