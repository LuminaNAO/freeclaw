import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

import { ttsHandlers } from "./tts.js";

async function invoke(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await ttsHandlers[method]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("gateway tts methods – local providers", () => {
  let root: string;
  let prefsPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "openclaw-gw-tts-"));
    prefsPath = path.join(root, "prefs.json");
    loadConfig.mockReturnValue({
      messages: {
        tts: {
          prefsPath,
          kokoro: { enabled: true, scriptPath: "/opt/kokoro/kokoro_tts.py" },
        },
      },
    } as OpenClawConfig);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("tts.setProvider accepts kokoro and persists it", async () => {
    const respond = await invoke("tts.setProvider", { provider: "kokoro" });
    expect(respond).toHaveBeenCalledWith(true, { provider: "kokoro" });
    expect(JSON.parse(readFileSync(prefsPath, "utf8"))).toMatchObject({
      tts: { provider: "kokoro" },
    });
  });

  it("tts.setProvider accepts qwen3", async () => {
    const respond = await invoke("tts.setProvider", { provider: "qwen3" });
    expect(respond).toHaveBeenCalledWith(true, { provider: "qwen3" });
  });

  it.each(["edge", "openai", "elevenlabs"])("tts.setProvider refuses %s", async (legacy) => {
    const respond = await invoke("tts.setProvider", { provider: legacy });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Invalid provider. Use qwen3 or kokoro." }),
    );
  });

  it("tts.providers lists qwen3 and kokoro with configured state", async () => {
    const respond = await invoke("tts.providers");
    expect(respond).toHaveBeenCalledWith(true, {
      providers: [
        expect.objectContaining({ id: "qwen3", configured: false }),
        expect.objectContaining({ id: "kokoro", configured: true }),
      ],
      active: "qwen3",
    });
  });

  it("tts.status reports kokoro as the configured fallback for a qwen3 primary", async () => {
    const respond = await invoke("tts.status");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "qwen3",
        fallbackProvider: "kokoro",
        fallbackProviders: ["kokoro"],
        qwen3Configured: false,
        kokoroConfigured: true,
      }),
    );
  });
});
