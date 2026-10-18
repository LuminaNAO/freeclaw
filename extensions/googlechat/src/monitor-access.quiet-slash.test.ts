/**
 * docs/design/agent-peers-and-quiet-sessions.md §3.1 at Google Chat ingress: in a
 * `slashCommands: false` session an unauthorized `/…` is ordinary text (not dropped as a control
 * command and no mention bypass). Placeholder ids only.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/googlechat";
import { describe, expect, it, vi } from "vitest";
import { applyGoogleChatInboundAccessPolicy } from "./monitor-access.js";

const SESSION = "agent:main:googlechat:group:spaces/quiet";

async function run(params: { quiet: boolean; requireMention: boolean }) {
  const isSlashTextForQuietSession = vi.fn(() => params.quiet);
  const core = {
    channel: {
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      commands: {
        shouldComputeCommandAuthorized: () => true,
        resolveCommandAuthorizedFromAuthorizers: () => false,
        shouldHandleTextCommands: () => true,
        isControlCommandMessage: (text: string) => text.trim().startsWith("/"),
        isSlashTextForQuietSession,
      },
      text: { hasControlCommand: (text: string) => text.trim().startsWith("/") },
    },
  };
  const result = await applyGoogleChatInboundAccessPolicy({
    account: {
      accountId: "default",
      config: {
        groupPolicy: "open",
        requireMention: params.requireMention,
        dm: { policy: "allowlist", allowFrom: ["users/owner"] },
      },
    } as never,
    config: { channels: { googlechat: {} } } as OpenClawConfig,
    core: core as never,
    space: { name: "spaces/quiet", type: "ROOM", displayName: "Quiet" } as never,
    message: { annotations: [] } as never,
    isGroup: true,
    senderId: "users/member",
    senderName: "Member",
    rawBody: "/status",
    sessionKey: SESSION,
    logVerbose: () => {},
  });
  return { result, isSlashTextForQuietSession };
}

describe("googlechat ingress quiet sessions (ARCH §3.1)", () => {
  it("unset: an unauthorized group /status is dropped as a control command", async () => {
    const { result } = await run({ quiet: false, requireMention: false });
    expect(result.ok).toBe(false);
  });

  it("slashCommands: false: /status is ordinary text and passes ingress", async () => {
    const { result, isSlashTextForQuietSession } = await run({
      quiet: true,
      requireMention: false,
    });
    expect(result.ok).toBe(true);
    expect(isSlashTextForQuietSession).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/status", sessionKey: SESSION }),
    );
  });

  it("slashCommands: false: no mention bypass for /status when a mention is required", async () => {
    const { result } = await run({ quiet: true, requireMention: true });
    expect(result.ok).toBe(false);
  });
});
