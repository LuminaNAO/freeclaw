import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

// signal-attachment-names §3.6: the real resolveOutboundAttachmentFromUrl, only the RPC is faked.
const rpcMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => ({}) };
});

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("sendMessageSignal attachment names (signal-attachment-names §3.6)", () => {
  let tempHome: TempHomeEnv;
  let srcDir = "";
  let outboundDir = "";
  let sendMessageSignal: typeof import("./send.js").sendMessageSignal;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-signal-names-");
    srcDir = path.join(tempHome.home, "out");
    await fs.mkdir(srcDir, { recursive: true });
    ({ sendMessageSignal } = await import("./send.js"));
    const { getMediaDir } = await import("../media/store.js");
    outboundDir = path.join(getMediaDir(), "outbound");
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 123 });
  });

  function sentAttachment(): string {
    const params = rpcMock.mock.lastCall?.[1] as Record<string, unknown>;
    const attachments = params.attachments as string[];
    expect(attachments).toHaveLength(1);
    return attachments[0] ?? "";
  }

  it("hands signal-cli media/outbound/<uuid>/<source name>", async () => {
    const source = path.join(srcDir, "Name With Spaces.pdf");
    const bytes = Buffer.from("%PDF-1.4\nbody\n");
    await fs.writeFile(source, bytes);

    await sendMessageSignal("+15551234567", "here it is", {
      mediaUrl: source,
      mediaLocalRoots: [srcDir],
    });

    const attachment = sentAttachment();
    expect(path.basename(attachment)).toBe("Name With Spaces.pdf");
    expect(path.dirname(path.dirname(attachment))).toBe(outboundDir);
    expect(path.basename(path.dirname(attachment))).toMatch(UUID_RE);
    expect((await fs.readFile(attachment)).equals(bytes)).toBe(true);
    const params = rpcMock.mock.lastCall?.[1] as Record<string, unknown>;
    expect(params.message).toBe("here it is");
    expect(params).not.toHaveProperty("voiceNote");
  });

  it("keeps voice-note behaviour: flagged audio still goes out as a voice note", async () => {
    // Bytes that do not sniff as anything, so the MIME type comes from the extension (audio/mpeg).
    const source = path.join(srcDir, "voice-reply.mp3");
    await fs.writeFile(source, "not really audio");

    await sendMessageSignal("+15551234567", "Spoken text", {
      mediaUrl: source,
      mediaLocalRoots: [srcDir],
      voiceNote: true,
    });

    const attachment = sentAttachment();
    expect(path.basename(attachment)).toBe("voice-reply.mp3");
    const params = rpcMock.mock.lastCall?.[1] as Record<string, unknown>;
    expect(params.voiceNote).toBe(true);
    expect(params.message).toBe("Spoken text");

    await sendMessageSignal("+15551234567", "", {
      mediaUrl: source,
      mediaLocalRoots: [srcDir],
    });
    const plain = rpcMock.mock.lastCall?.[1] as Record<string, unknown>;
    expect(plain).not.toHaveProperty("voiceNote");
    expect(plain.message).toBe("");
    expect(path.dirname(sentAttachment())).not.toBe(path.dirname(attachment));
  });
});
