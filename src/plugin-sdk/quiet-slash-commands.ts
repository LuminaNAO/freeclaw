import type { CommandNormalizeOptions } from "../auto-reply/commands-registry.js";
import type { OpenClawConfig } from "../config/config.js";

/** The slice of the plugin runtime this helper uses. Older or partial runtimes still work. */
export type QuietSlashCommandsRuntime = {
  channel: {
    commands?: {
      isSlashTextForQuietSession?: (params: {
        text: string | undefined | null;
        cfg: OpenClawConfig;
        sessionKey?: string;
      }) => boolean;
    };
  };
};

/**
 * Quiet sessions ARCH §3.1 for channel plugins: the session-aware form of the runtime's control
 * command detector. Use it wherever an inbound message is classified as a control command
 * (unauthorized drop, mention bypass), so in a `slashCommands: false` session `/…` text is
 * ordinary text and reaches the model, while `/session` stays a command so an operator can undo
 * the setting. Without the setting it returns exactly `detect(text, cfg)`.
 */
export function hasSessionControlCommandWithRuntime(params: {
  runtime: QuietSlashCommandsRuntime;
  text: string | undefined | null;
  cfg: OpenClawConfig;
  sessionKey?: string;
  detect: (text: string, cfg: OpenClawConfig, options?: CommandNormalizeOptions) => boolean;
}): boolean {
  if (!params.detect(params.text ?? "", params.cfg)) {
    return false;
  }
  return !isSlashTextForQuietSessionWithRuntime(params);
}

/** Quiet sessions ARCH §3.1 for channel plugins: `/…` is ordinary text in this session. */
export function isSlashTextForQuietSessionWithRuntime(params: {
  runtime: QuietSlashCommandsRuntime;
  text: string | undefined | null;
  cfg: OpenClawConfig;
  sessionKey?: string;
}): boolean {
  const check = params.runtime.channel.commands?.isSlashTextForQuietSession;
  if (!params.sessionKey || typeof check !== "function") {
    return false;
  }
  return check({ text: params.text, cfg: params.cfg, sessionKey: params.sessionKey });
}
