import { describe, expect, it } from "vitest";
import { resolveSilentReplyPromptMode } from "./silent-reply.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const cfg = { surfaces: { signal: { silentReply: { group: "disallow" } } } } as OpenClawConfig;

describe("resolveSilentReplyPromptMode", () => {
  it("returns none for a disallowed group surface", () => {
    expect(resolveSilentReplyPromptMode({ cfg, channel: "signal", chatType: "group" })).toBe(
      "none",
    );
  });

  it("matches the channel case-insensitively", () => {
    expect(resolveSilentReplyPromptMode({ cfg, channel: "Signal", chatType: "group" })).toBe(
      "none",
    );
  });

  it("keeps generic for direct chats when only group is disallowed", () => {
    expect(resolveSilentReplyPromptMode({ cfg, channel: "signal", chatType: "direct" })).toBe(
      "generic",
    );
  });

  it("keeps generic for other channels, missing config, or missing channel", () => {
    expect(resolveSilentReplyPromptMode({ cfg, channel: "telegram", chatType: "group" })).toBe(
      "generic",
    );
    expect(
      resolveSilentReplyPromptMode({ cfg: undefined, channel: "signal", chatType: "group" }),
    ).toBe("generic");
    expect(resolveSilentReplyPromptMode({ cfg, channel: undefined, chatType: "group" })).toBe(
      "generic",
    );
  });
});
