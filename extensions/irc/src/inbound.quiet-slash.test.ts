/**
 * docs/design/agent-peers-and-quiet-sessions.md §3.1 at IRC ingress: in a `slashCommands: false`
 * session `/…` in a channel is ordinary text, so it does not bypass mention gating as a command.
 * (In IRC every admitted group sender is command-authorized, so mention bypass is the only
 * ingress effect of command classification.) Placeholder nicks only.
 */
import type { PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/irc";
import { describe, expect, it, vi } from "vitest";
import { handleIrcInbound } from "./inbound.js";
import { setIrcRuntime } from "./runtime.js";

const SESSION = "agent:main:irc:group:#quiet";

async function run(quiet: boolean) {
  const isSlashTextForQuietSession = vi.fn(() => quiet);
  setIrcRuntime({
    channel: {
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      commands: {
        shouldHandleTextCommands: () => true,
        isSlashTextForQuietSession,
      },
      text: { hasControlCommand: (text: string) => text.trim().startsWith("/") },
      routing: {
        resolveAgentRoute: () => ({
          agentId: "main",
          accountId: "default",
          sessionKey: SESSION,
          mainSessionKey: "agent:main:main",
        }),
      },
      mentions: { buildMentionRegexes: () => [], matchesMentionPatterns: () => false },
    },
  } as unknown as PluginRuntime);
  const log = vi.fn();
  // Only ingress classification is asserted; later stages are not stubbed.
  await handleIrcInbound({
    message: {
      messageId: "m-q",
      target: "#quiet",
      senderNick: "member",
      text: "/status",
      timestamp: Date.now(),
      isGroup: true,
    },
    account: {
      accountId: "default",
      nick: "bot",
      config: {
        dmPolicy: "pairing",
        groupPolicy: "open",
        allowFrom: ["owner"],
        groupAllowFrom: ["*"],
        groups: { "#quiet": { requireMention: true } },
      },
    } as never,
    config: { channels: { irc: {} } } as never,
    runtime: { log, error: vi.fn() } as unknown as RuntimeEnv,
  }).catch(() => undefined);
  const skippedNoMention = log.mock.calls.some((call) =>
    String(call[0]).includes("missing-mention"),
  );
  return { isSlashTextForQuietSession, skippedNoMention };
}

describe("irc ingress quiet sessions (ARCH §3.1)", () => {
  it("unset: an unmentioned /status bypasses mention gating as a command (today)", async () => {
    const { skippedNoMention } = await run(false);
    expect(skippedNoMention).toBe(false);
  });

  it("slashCommands: false: /status is ordinary text, so no mention bypass", async () => {
    const { skippedNoMention, isSlashTextForQuietSession } = await run(true);
    expect(isSlashTextForQuietSession).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/status", sessionKey: SESSION }),
    );
    expect(skippedNoMention).toBe(true);
  });
});
