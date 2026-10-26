import { loadConfig } from "../../config/config.js";
import {
  getTtsProvider,
  isSupportedTtsProvider,
  isTtsEnabled,
  isTtsProviderConfigured,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setTtsEnabled,
  setTtsProvider,
  resolveTtsProviderOrder,
  textToSpeech,
  TTS_PROVIDERS,
} from "../../tts/tts.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const ttsHandlers: GatewayRequestHandlers = {
  "tts.status": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const provider = getTtsProvider(config, prefsPath);
      const autoMode = resolveTtsAutoMode({ config, prefsPath });
      const fallbackProviders = resolveTtsProviderOrder(provider)
        .slice(1)
        .filter((id) => isTtsProviderConfigured(config, id));
      respond(true, {
        enabled: isTtsEnabled(config, prefsPath),
        auto: autoMode,
        provider,
        fallbackProvider: fallbackProviders[0] ?? null,
        fallbackProviders,
        prefsPath,
        qwen3Configured: isTtsProviderConfigured(config, "qwen3"),
        kokoroConfigured: isTtsProviderConfigured(config, "kokoro"),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.enable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, true);
      respond(true, { enabled: true });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.disable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, false);
      respond(true, { enabled: false });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.convert": async ({ params, respond }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tts.convert requires text"),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const channel = typeof params.channel === "string" ? params.channel.trim() : undefined;
      const result = await textToSpeech({ text, cfg, channel });
      if (result.success && result.audioPath) {
        respond(true, {
          audioPath: result.audioPath,
          provider: result.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
        });
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "TTS conversion failed"),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.setProvider": async ({ params, respond }) => {
    const provider = typeof params.provider === "string" ? params.provider.trim() : "";
    if (!isSupportedTtsProvider(provider)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Invalid provider. Use ${TTS_PROVIDERS.join(" or ")}.`,
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsProvider(prefsPath, provider);
      respond(true, { provider });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.providers": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      respond(true, {
        providers: [
          {
            id: "qwen3",
            name: "Qwen3 TTS",
            configured: isTtsProviderConfigured(config, "qwen3"),
            models: [config.qwen3.model],
          },
          {
            id: "kokoro",
            name: "Kokoro TTS",
            configured: isTtsProviderConfigured(config, "kokoro"),
            models: ["Kokoro-82M"],
          },
        ],
        active: getTtsProvider(config, prefsPath),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
