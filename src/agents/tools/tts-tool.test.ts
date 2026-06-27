import { describe, expect, it, vi } from "vitest";

vi.mock("../../auto-reply/tokens.js", () => ({
  SILENT_REPLY_TOKEN: "QUIET_TOKEN",
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ messages: { tts: {} } })),
}));

vi.mock("../../tts/tts.js", () => ({
  textToSpeech: vi.fn(),
}));

const { textToSpeech } = await import("../../tts/tts.js");
const { createTtsTool } = await import("./tts-tool.js");

describe("createTtsTool", () => {
  it("uses SILENT_REPLY_TOKEN in guidance text", () => {
    const tool = createTtsTool();

    expect(tool.description).toContain("QUIET_TOKEN");
    expect(tool.description).not.toContain("NO_REPLY");
  });

  it("returns voice-note media markup for voice-compatible audio", async () => {
    vi.mocked(textToSpeech).mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/openclaw-qwen-note.opus",
      provider: "qwen3",
      latencyMs: 12,
      outputFormat: "opus",
      voiceCompatible: true,
    });

    const tool = createTtsTool({ agentChannel: "telegram" });
    const result = await tool.execute("call-1", { text: "Make a voice note" });

    expect(textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Make a voice note",
        channel: "telegram",
      }),
    );
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("[[audio_as_voice]]\nMEDIA:/tmp/openclaw-qwen-note.opus");
    expect(result.details).toEqual({
      audioPath: "/tmp/openclaw-qwen-note.opus",
      provider: "qwen3",
    });
  });

  it("returns plain media markup for Signal audio attachments", async () => {
    vi.mocked(textToSpeech).mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/openclaw-qwen-note.mp3",
      provider: "qwen3",
      latencyMs: 12,
      outputFormat: "mp3",
      voiceCompatible: false,
    });

    const tool = createTtsTool({ agentChannel: "signal" });
    const result = await tool.execute("call-1", { text: "Make a Signal voice note" });

    expect(textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Make a Signal voice note",
        channel: "signal",
      }),
    );
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("MEDIA:/tmp/openclaw-qwen-note.mp3");
    expect(result.details).toEqual({
      audioPath: "/tmp/openclaw-qwen-note.mp3",
      provider: "qwen3",
    });
  });
});
