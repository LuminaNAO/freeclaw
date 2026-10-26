import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { TtsConfigSchema } from "../config/zod-schema.core.js";
import { runFfmpeg } from "../media/ffmpeg-exec.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import * as tts from "./tts.js";

// ffmpeg is replaced with a copy so no codec is needed; the tests check which codec was requested.
vi.mock("../media/ffmpeg-exec.js", async () => {
  const fs = await import("node:fs");
  return {
    runFfmpeg: vi.fn(async (args: string[]) => {
      const inputIndex = args.indexOf("-i");
      const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
      const outputPath = args.at(-1);
      if (!inputPath || !outputPath) {
        throw new Error("invalid ffmpeg args");
      }
      fs.copyFileSync(inputPath, outputPath);
      return "";
    }),
  };
});

const {
  _test,
  resolveTtsConfig,
  getTtsProvider,
  setTtsProvider,
  isTtsProviderConfigured,
  resolveTtsProviderOrder,
  textToSpeech,
  TTS_PROVIDERS,
} = tts;

// The fake "python" is the running node binary and the fake script is a tiny node stub,
// so these tests need neither Python nor the kokoro package nor any model download.
const NODE = process.execPath;

/** Node stub that records argv and writes a minimal valid 24 kHz mono 16-bit WAV. */
function successStub(argvPath: string): string {
  return `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv));
const out = argv[argv.indexOf("--output") + 1];
const samples = 2400;
const dataLen = samples * 2;
const buf = Buffer.alloc(44 + dataLen);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataLen, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(24000, 24);
buf.writeUInt32LE(48000, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataLen, 40);
fs.writeFileSync(out, buf);
`;
}

const FAILING_STUB = `
process.stderr.write("some progress noise\\n");
process.stderr.write("kokoro_tts: voice zz_nobody not found\\n");
process.exit(3);
`;

function hangingStub(pidPath: string): string {
  return `
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`;
}

type Fixture = { root: string; scriptPath: string; prefsPath: string; argvPath: string };

function createFixture(body: (fx: Fixture) => string): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-kokoro-tts-"));
  const fx: Fixture = {
    root,
    scriptPath: path.join(root, "fake_kokoro.cjs"),
    prefsPath: path.join(root, "prefs.json"),
    argvPath: path.join(root, "argv.json"),
  };
  writeFileSync(fx.scriptPath, body(fx), "utf8");
  return fx;
}

function kokoroCfg(
  fx: Fixture,
  overrides: Partial<NonNullable<NonNullable<OpenClawConfig["messages"]>["tts"]>> = {},
): OpenClawConfig {
  return {
    messages: {
      tts: {
        provider: "kokoro",
        prefsPath: fx.prefsPath,
        kokoro: {
          enabled: true,
          scriptPath: fx.scriptPath,
          python: NODE,
          voice: "bf_emma",
          lang: "b",
          speed: 1.25,
          timeoutMs: 5000,
        },
        ...overrides,
      },
    },
  };
}

const CLEAN_ENV = {
  KOKORO_TTS_SCRIPT: undefined,
  KOKORO_TTS_PYTHON: undefined,
  PYTHON: undefined,
  QWEN3_TTS_SCRIPT: undefined,
  QWEN3_TTS_PYTHON: undefined,
  OPENCLAW_TTS_PREFS: undefined,
};

describe("kokoro TTS", () => {
  const fixtures: Fixture[] = [];
  const track = (fx: Fixture) => {
    fixtures.push(fx);
    return fx;
  };

  beforeEach(() => {
    vi.mocked(runFfmpeg).mockClear();
  });

  afterEach(() => {
    for (const fx of fixtures.splice(0)) {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  describe("schema", () => {
    it("accepts a full kokoro block and kokoro as provider", () => {
      const result = TtsConfigSchema.safeParse({
        provider: "kokoro",
        kokoro: {
          enabled: true,
          scriptPath: "/opt/kokoro/kokoro_tts.py",
          python: "/opt/kokoro/venv/bin/python",
          voice: "af_heart",
          lang: "a",
          speed: 1,
          timeoutMs: 60000,
        },
      });
      expect(result.success).toBe(true);
    });

    it("is strict: unknown kokoro keys are rejected", () => {
      const result = TtsConfigSchema.safeParse({ kokoro: { enabled: true, device: "cpu" } });
      expect(result.success).toBe(false);
    });

    it("enforces speed and timeoutMs ranges", () => {
      const cases: Array<[Record<string, unknown>, boolean]> = [
        [{ speed: 0.5 }, true],
        [{ speed: 2 }, true],
        [{ speed: 0.49 }, false],
        [{ speed: 2.01 }, false],
        [{ timeoutMs: 1000 }, true],
        [{ timeoutMs: 600000 }, true],
        [{ timeoutMs: 999 }, false],
        [{ timeoutMs: 600001 }, false],
        [{ timeoutMs: 1500.5 }, false],
        [{ enabled: "yes" }, false],
      ];
      for (const [kokoro, ok] of cases) {
        expect(TtsConfigSchema.safeParse({ kokoro }).success, JSON.stringify(kokoro)).toBe(ok);
      }
    });

    it("provider enum includes qwen3 and kokoro and rejects unknown ids", () => {
      expect(TtsConfigSchema.safeParse({ provider: "qwen3" }).success).toBe(true);
      expect(TtsConfigSchema.safeParse({ provider: "kokoro" }).success).toBe(true);
      expect(TtsConfigSchema.safeParse({ provider: "piper" }).success).toBe(false);
    });
  });

  describe("resolveTtsConfig – kokoro", () => {
    it("applies defaults", () => {
      withEnv(CLEAN_ENV, () => {
        const config = resolveTtsConfig({ messages: { tts: {} } });
        expect(config.kokoro).toEqual({
          enabled: false,
          scriptPath: undefined,
          python: "python3",
          voice: "af_heart",
          lang: "a",
          speed: 1,
          timeoutMs: 60000,
        });
      });
    });

    it("falls back to env for scriptPath and python (KOKORO_TTS_PYTHON before PYTHON)", () => {
      withEnv(
        {
          ...CLEAN_ENV,
          KOKORO_TTS_SCRIPT: "/env/kokoro.py",
          KOKORO_TTS_PYTHON: "/env/kokoro-python",
          PYTHON: "/env/python",
        },
        () => {
          const config = resolveTtsConfig({ messages: { tts: {} } });
          expect(config.kokoro.scriptPath).toBe("/env/kokoro.py");
          expect(config.kokoro.python).toBe("/env/kokoro-python");
        },
      );
      withEnv({ ...CLEAN_ENV, PYTHON: "/env/python" }, () => {
        expect(resolveTtsConfig({ messages: { tts: {} } }).kokoro.python).toBe("/env/python");
      });
    });

    it("prefers config over env", () => {
      withEnv(
        { ...CLEAN_ENV, KOKORO_TTS_SCRIPT: "/env/kokoro.py", KOKORO_TTS_PYTHON: "/env/py" },
        () => {
          const config = resolveTtsConfig({
            messages: { tts: { kokoro: { scriptPath: "/cfg/kokoro.py", python: "/cfg/py" } } },
          });
          expect(config.kokoro.scriptPath).toBe("/cfg/kokoro.py");
          expect(config.kokoro.python).toBe("/cfg/py");
        },
      );
    });

    it("counts kokoro as configured only when enabled with a script path", () => {
      withEnv(CLEAN_ENV, () => {
        const check = (kokoro: Record<string, unknown>) =>
          isTtsProviderConfigured(resolveTtsConfig({ messages: { tts: { kokoro } } }), "kokoro");
        expect(check({ enabled: true, scriptPath: "/x.py" })).toBe(true);
        expect(check({ enabled: true })).toBe(false);
        expect(check({ enabled: false, scriptPath: "/x.py" })).toBe(false);
      });
    });
  });

  describe("provider selection", () => {
    it("exposes exactly the two local providers", () => {
      expect([...TTS_PROVIDERS]).toEqual(["qwen3", "kokoro"]);
    });

    it("selects kokoro from config", () => {
      withEnv(CLEAN_ENV, () => {
        const prefsPath = path.join(os.tmpdir(), `tts-kokoro-none-${Date.now()}.json`);
        const config = resolveTtsConfig({ messages: { tts: { provider: "kokoro" } } });
        expect(getTtsProvider(config, prefsPath)).toBe("kokoro");
      });
    });

    it("selects kokoro from prefs over a qwen3 config", () => {
      const fx = track(createFixture(() => ""));
      setTtsProvider(fx.prefsPath, "kokoro");
      expect(JSON.parse(readFileSync(fx.prefsPath, "utf8"))).toMatchObject({
        tts: { provider: "kokoro" },
      });
      const config = resolveTtsConfig({ messages: { tts: { provider: "qwen3" } } });
      expect(getTtsProvider(config, fx.prefsPath)).toBe("kokoro");
    });

    it("still refuses edge/openai/elevenlabs from prefs, config and setTtsProvider", () => {
      const fx = track(createFixture(() => ""));
      for (const legacy of ["edge", "openai", "elevenlabs"] as const) {
        expect(() => setTtsProvider(fx.prefsPath, legacy)).toThrow(
          "Only qwen3 or kokoro are supported as TTS providers",
        );
        writeFileSync(fx.prefsPath, JSON.stringify({ tts: { provider: legacy } }));
        const config = resolveTtsConfig({ messages: { tts: { provider: legacy } } });
        expect(getTtsProvider(config, fx.prefsPath)).toBe("qwen3");
        expect(resolveTtsProviderOrder(legacy)).toEqual(["qwen3", "kokoro"]);
      }
    });

    it("orders the selected provider first, the other local provider second", () => {
      expect(resolveTtsProviderOrder("kokoro")).toEqual(["kokoro", "qwen3"]);
      expect(resolveTtsProviderOrder("qwen3")).toEqual(["qwen3", "kokoro"]);
    });

    it("accepts kokoro as a [[tts:provider]] directive and still rejects cloud providers", () => {
      const policy = _test.resolveModelOverridePolicy({ enabled: true, allowProvider: true });
      expect(_test.parseTtsDirectives("Hi [[tts:provider=kokoro]] there", policy)).toMatchObject({
        overrides: { provider: "kokoro" },
      });
      const rejected = _test.parseTtsDirectives("Hi [[tts:provider=openai]] there", policy);
      expect(rejected.overrides.provider).toBeUndefined();
      expect(rejected.warnings).toContain('unsupported provider "openai"');
    });
  });

  describe("textToSpeech – kokoro runtime", () => {
    it("runs the script with the §2.3 args and returns opus for a voice-compatible channel", async () => {
      const fx = track(createFixture((f) => successStub(f.argvPath)));
      const result = await withEnvAsync(CLEAN_ENV, () =>
        textToSpeech({ text: "Hello from Kokoro", cfg: kokoroCfg(fx), channel: "telegram" }),
      );

      expect(result.success, result.error).toBe(true);
      expect(result.provider).toBe("kokoro");
      expect(result.outputFormat).toBe("opus");
      expect(result.voiceCompatible).toBe(true);
      expect(result.audioPath).toMatch(/\.opus$/);
      expect(existsSync(result.audioPath!)).toBe(true);
      expect(runFfmpeg).toHaveBeenCalledWith(
        expect.arrayContaining(["-c:a", "libopus", result.audioPath]),
        expect.objectContaining({ timeoutMs: 5000 }),
      );

      const argv = JSON.parse(readFileSync(fx.argvPath, "utf8")) as string[];
      const wav = argv[3];
      expect(argv).toEqual([
        "--text",
        "Hello from Kokoro",
        "--output",
        wav,
        "--voice",
        "bf_emma",
        "--lang",
        "b",
        "--speed",
        "1.25",
      ]);
      expect(wav).toMatch(/\.wav$/);
      // The stub wrote a real 24 kHz RIFF/WAVE file (the ffmpeg mock copies it to the output).
      const header = readFileSync(result.audioPath!);
      expect(header.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(header.subarray(8, 12).toString("latin1")).toBe("WAVE");
      expect(header.readUInt32LE(24)).toBe(24000);
    });

    it("returns mp3 for a non voice-bubble channel (signal)", async () => {
      const fx = track(createFixture((f) => successStub(f.argvPath)));
      const result = await withEnvAsync(CLEAN_ENV, () =>
        textToSpeech({ text: "Hello Signal", cfg: kokoroCfg(fx), channel: "signal" }),
      );

      expect(result.success, result.error).toBe(true);
      expect(result.provider).toBe("kokoro");
      expect(result.outputFormat).toBe("mp3");
      expect(result.voiceCompatible).toBe(false);
      expect(result.audioPath).toMatch(/\.mp3$/);
      expect(runFfmpeg).toHaveBeenCalledWith(
        expect.arrayContaining(["-c:a", "libmp3lame", result.audioPath]),
        expect.anything(),
      );
    });

    it("reports kokoro: disabled (and qwen3: disabled) when nothing is enabled", async () => {
      const fx = track(createFixture((f) => successStub(f.argvPath)));
      const cfg = kokoroCfg(fx);
      cfg.messages!.tts!.kokoro!.enabled = false;
      const result = await withEnvAsync(CLEAN_ENV, () => textToSpeech({ text: "Hello", cfg }));

      expect(result.success).toBe(false);
      expect(result.error).toBe("TTS conversion failed: kokoro: disabled; qwen3: disabled");
      expect(existsSync(fx.argvPath)).toBe(false);
    });

    it("reports kokoro: scriptPath not configured", async () => {
      const fx = track(createFixture(() => ""));
      const cfg = kokoroCfg(fx);
      delete cfg.messages!.tts!.kokoro!.scriptPath;
      const result = await withEnvAsync(CLEAN_ENV, () => textToSpeech({ text: "Hello", cfg }));

      expect(result.success).toBe(false);
      expect(result.error).toContain("kokoro: scriptPath not configured");
    });

    it("surfaces the stderr tail when the script exits non-zero and cleans up", async () => {
      const fx = track(createFixture(() => FAILING_STUB));
      const result = await withEnvAsync(CLEAN_ENV, () =>
        textToSpeech({ text: "Hello", cfg: kokoroCfg(fx), channel: "telegram" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("kokoro: Kokoro-TTS failed (exit 3)");
      expect(result.error).toContain("kokoro_tts: voice zz_nobody not found");
      expect(result.error).not.toContain("edge:");
      expect(runFfmpeg).not.toHaveBeenCalled();
    });

    it("kills the child on timeout", async () => {
      const pidPath = path.join(os.tmpdir(), `kokoro-hang-${process.pid}-${Date.now()}.pid`);
      const fx = track(createFixture(() => hangingStub(pidPath)));
      const cfg = kokoroCfg(fx);
      cfg.messages!.tts!.kokoro!.timeoutMs = 1000;
      try {
        const result = await withEnvAsync(CLEAN_ENV, () => textToSpeech({ text: "Hello", cfg }));

        expect(result.success).toBe(false);
        expect(result.error).toContain("kokoro: Kokoro-TTS timed out after 1000ms");
        const pid = Number(readFileSync(pidPath, "utf8"));
        expect(pid).toBeGreaterThan(0);
        await vi.waitFor(
          () => {
            expect(isAlive(pid)).toBe(false);
          },
          { timeout: 4000, interval: 50 },
        );
      } finally {
        rmSync(pidPath, { force: true });
      }
    }, 10_000);

    it("falls back from a disabled primary to the enabled other provider", async () => {
      const fx = track(createFixture((f) => successStub(f.argvPath)));
      // Primary qwen3 is disabled; kokoro is enabled and should serve the request.
      const cfg = kokoroCfg(fx, {
        provider: "qwen3",
        qwen3: { enabled: false, scriptPath: "/nonexistent/qwen3.py" },
      });
      const result = await withEnvAsync(CLEAN_ENV, () =>
        textToSpeech({ text: "Fallback please", cfg, channel: "signal" }),
      );

      expect(result.success, result.error).toBe(true);
      expect(result.provider).toBe("kokoro");
      expect(result.outputFormat).toBe("mp3");
    });

    it("falls back from a disabled kokoro primary to an enabled qwen3", async () => {
      const qfx = track(createFixture((f) => successStub(f.argvPath)));
      const cfg: OpenClawConfig = {
        messages: {
          tts: {
            provider: "kokoro",
            prefsPath: qfx.prefsPath,
            kokoro: { enabled: false },
            qwen3: { enabled: true, scriptPath: qfx.scriptPath, timeoutMs: 5000 },
          },
        },
      };
      const result = await withEnvAsync({ ...CLEAN_ENV, QWEN3_TTS_PYTHON: NODE }, () =>
        textToSpeech({ text: "Fallback to qwen3", cfg, channel: "telegram" }),
      );

      expect(result.success, result.error).toBe(true);
      expect(result.provider).toBe("qwen3");
      expect(result.outputFormat).toBe("opus");
    });

    it("is not used for telephony", async () => {
      const fx = track(createFixture((f) => successStub(f.argvPath)));
      const result = await withEnvAsync(CLEAN_ENV, () =>
        tts.textToSpeechTelephony({ text: "Hello caller", cfg: kokoroCfg(fx) }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("kokoro: unsupported for telephony");
      expect(existsSync(fx.argvPath)).toBe(false);
    });
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
