import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  isMessagingChannelInbound,
  resolveConfiguredReasoningDefault,
  resolveUnsetReasoningLevel,
} from "./reasoning-default.js";

// reasoning-display ARCH §2

describe("isMessagingChannelInbound", () => {
  it.each(["signal", "whatsapp", "telegram", "discord", "slack", "imessage", "msteams", "matrix"])(
    "treats %s as a messaging channel",
    (channel) => {
      expect(isMessagingChannelInbound({ Provider: channel, Surface: channel })).toBe(true);
    },
  );

  it("treats a channel delivery route as a messaging channel even from an internal source", () => {
    expect(
      isMessagingChannelInbound({
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "signal",
      }),
    ).toBe(true);
    expect(
      isMessagingChannelInbound({ Provider: "heartbeat", OriginatingChannel: "telegram" }),
    ).toBe(true);
  });

  it.each([
    {},
    { Provider: "webchat", Surface: "webchat", OriginatingChannel: "webchat" },
    { Provider: "heartbeat" },
    { Provider: "cron-event" },
    { Provider: "exec-event" },
  ])("treats non-channel surfaces as internal: %o", (ctx) => {
    expect(isMessagingChannelInbound(ctx)).toBe(false);
  });
});

describe("resolveConfiguredReasoningDefault", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveConfiguredReasoningDefault({}, "main")).toBeUndefined();
  });

  it("reads agents.defaults.reasoningDefault", () => {
    const cfg: OpenClawConfig = { agents: { defaults: { reasoningDefault: "stream" } } };
    expect(resolveConfiguredReasoningDefault(cfg, "main")).toBe("stream");
  });

  it("prefers the per-agent value", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { reasoningDefault: "on" },
        list: [{ id: "quiet", reasoningDefault: "off" }],
      },
    };
    expect(resolveConfiguredReasoningDefault(cfg, "quiet")).toBe("off");
    expect(resolveConfiguredReasoningDefault(cfg, "other")).toBe("on");
  });
});

describe("resolveUnsetReasoningLevel", () => {
  const catalogOn = () => vi.fn(async () => "on" as const);

  it("keeps channels off without consulting the catalog", async () => {
    const resolveCatalogDefault = catalogOn();
    await expect(
      resolveUnsetReasoningLevel({
        cfg: {},
        agentId: "main",
        ctx: { Provider: "signal", Surface: "signal", OriginatingChannel: "signal" },
        thinkingActive: false,
        resolveCatalogDefault,
      }),
    ).resolves.toBe("off");
    expect(resolveCatalogDefault).not.toHaveBeenCalled();
  });

  it("uses a configured default on channels", async () => {
    await expect(
      resolveUnsetReasoningLevel({
        cfg: { agents: { defaults: { reasoningDefault: "on" } } },
        agentId: "main",
        ctx: { Provider: "signal" },
        thinkingActive: false,
        resolveCatalogDefault: catalogOn(),
      }),
    ).resolves.toBe("on");
  });

  it("keeps the catalog default on non-channel surfaces when thinking is off", async () => {
    await expect(
      resolveUnsetReasoningLevel({
        cfg: {},
        agentId: "main",
        ctx: { Provider: "webchat", Surface: "webchat" },
        thinkingActive: false,
        resolveCatalogDefault: catalogOn(),
      }),
    ).resolves.toBe("on");
  });

  it("keeps non-channel surfaces off while thinking is active (unchanged)", async () => {
    const resolveCatalogDefault = catalogOn();
    await expect(
      resolveUnsetReasoningLevel({
        cfg: {},
        agentId: "main",
        ctx: {},
        thinkingActive: true,
        resolveCatalogDefault,
      }),
    ).resolves.toBe("off");
    expect(resolveCatalogDefault).not.toHaveBeenCalled();
  });

  it("an explicit configured off wins over the catalog on non-channel surfaces", async () => {
    await expect(
      resolveUnsetReasoningLevel({
        cfg: { agents: { defaults: { reasoningDefault: "off" } } },
        agentId: "main",
        ctx: {},
        thinkingActive: false,
        resolveCatalogDefault: catalogOn(),
      }),
    ).resolves.toBe("off");
  });
});
