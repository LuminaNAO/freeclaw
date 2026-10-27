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
const { extractToolResultMediaHints, extractToolResultMediaPaths } =
  await import("../pi-embedded-subscribe.tools.js");

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string | undefined {
  const block = result.content[0];
  return block?.type === "text" ? block.text : undefined;
}

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
    expect(firstText(result)).toBe("[[audio_as_voice]]\nMEDIA:/tmp/openclaw-qwen-note.opus");
    expect(result.details).toEqual({
      audioPath: "/tmp/openclaw-qwen-note.opus",
      provider: "qwen3",
      transcript: "Make a voice note",
    });
  });

  it("returns plain media markup for non-voice audio", async () => {
    vi.mocked(textToSpeech).mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/openclaw-qwen-note.mp3",
      provider: "qwen3",
      latencyMs: 12,
      outputFormat: "mp3",
      voiceCompatible: false,
    });

    const tool = createTtsTool({ agentChannel: "slack" });
    const result = await tool.execute("call-1", { text: "Make an audio file" });

    expect(firstText(result)).toBe("MEDIA:/tmp/openclaw-qwen-note.mp3");
    expect(result.details).toEqual({
      audioPath: "/tmp/openclaw-qwen-note.mp3",
      provider: "qwen3",
      transcript: "Make an audio file",
    });
  });

  it("on Signal yields opus media, the voice tag and the spoken text as transcript (voice ARCH §3)", async () => {
    vi.mocked(textToSpeech).mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/openclaw-qwen-note.opus",
      provider: "qwen3",
      latencyMs: 12,
      outputFormat: "opus",
      voiceCompatible: true,
    });

    const tool = createTtsTool({ agentChannel: "signal" });
    const result = await tool.execute("call-1", { text: "Hello from Signal" });

    expect(textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello from Signal", channel: "signal" }),
    );
    expect(firstText(result)).toBe("[[audio_as_voice]]\nMEDIA:/tmp/openclaw-qwen-note.opus");
    expect(extractToolResultMediaPaths(result)).toEqual(["/tmp/openclaw-qwen-note.opus"]);
    expect(extractToolResultMediaHints(result)).toEqual({
      audioAsVoice: true,
      transcript: "Hello from Signal",
    });
  });

  it("carries no transcript when synthesis fails", async () => {
    vi.mocked(textToSpeech).mockResolvedValueOnce({ success: false, error: "no provider" });

    const tool = createTtsTool({ agentChannel: "signal" });
    const result = await tool.execute("call-1", { text: "Hello" });

    expect(firstText(result)).toBe("no provider");
    expect(extractToolResultMediaPaths(result)).toEqual([]);
    expect(extractToolResultMediaHints(result)).toEqual({ audioAsVoice: false });
  });
});
