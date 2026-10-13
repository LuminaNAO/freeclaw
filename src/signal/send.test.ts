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
        message: "<media:audio>",
        recipient: ["+15551234567"],
      }),
      expect.objectContaining({ baseUrl: "http://signal.local" }),
    );
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
