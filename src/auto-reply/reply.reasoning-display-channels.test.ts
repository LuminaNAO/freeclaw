import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
  installDirectiveBehaviorE2EHooks,
  loadModelCatalog,
  makeEmbeddedTextResult,
  makeWhatsAppDirectiveConfig,
  replyText,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { runEmbeddedPiAgentMock } from "./reply.directive.directive-behavior.e2e-mocks.js";
import { getReplyFromConfig } from "./reply.js";

// reasoning-display ARCH §3: reasoning display is never auto-enabled on messaging channels.

const SIGNAL_INBOUND = {
  From: "signal:+15550001",
  To: "signal:+15550002",
  Provider: "signal",
  Surface: "signal",
  OriginatingChannel: "signal",
  OriginatingTo: "signal:+15550001",
  ChatType: "direct",
  CommandAuthorized: true,
} as const;

function mockReasoningCapableCatalog() {
  vi.mocked(loadModelCatalog).mockResolvedValue([
    { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic", reasoning: true },
  ]);
}

function makeConfig(
  home: string,
  defaults: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return makeWhatsAppDirectiveConfig(
    home,
    { model: { primary: "anthropic/claude-opus-4-5" }, thinkingDefault: "off", ...defaults },
    {
      channels: { signal: { allowFrom: ["*"] }, whatsapp: { allowFrom: ["*"] } },
      session: { store: sessionStorePath(home) },
      ...extra,
    },
  );
}

function lastRunCall() {
  expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
  const calls = runEmbeddedPiAgentMock.mock.calls;
  return calls[calls.length - 1]?.[0] as { thinkLevel?: string; reasoningLevel?: string };
}

async function sendSignal(home: string, body: string, config = makeConfig(home)) {
  return getReplyFromConfig({ ...SIGNAL_INBOUND, Body: body }, {}, config);
}

describe("reasoning display on messaging channels (ARCH §3)", () => {
  installDirectiveBehaviorE2EHooks();

  it("Signal inbound, thinking off, reasoning-capable model, nothing set: reasoning off", async () => {
    await withTempHome(async (home) => {
      mockReasoningCapableCatalog();
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));

      await sendSignal(home, "hello");

      const call = lastRunCall();
      expect(call.thinkLevel).toBe("off");
      expect(call.reasoningLevel).toBe("off");
    });
  });

  it("Signal inbound with /reasoning on in the session: reasoning on", async () => {
    await withTempHome(async (home) => {
      mockReasoningCapableCatalog();
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));
      const config = makeConfig(home);

      const ack = await sendSignal(home, "/reasoning on", config);
      expect(replyText(ack)).toContain("Reasoning visibility enabled.");
      const entry = Object.values(loadSessionStore(sessionStorePath(home)))[0];
      expect(entry?.reasoningLevel).toBe("on");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();

      await sendSignal(home, "hello", config);
      const call = lastRunCall();
      expect(call.thinkLevel).toBe("off");
      expect(call.reasoningLevel).toBe("on");
    });
  });

  it('Signal inbound with agents.defaults.reasoningDefault: "on": reasoning on', async () => {
    await withTempHome(async (home) => {
      mockReasoningCapableCatalog();
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));

      await sendSignal(home, "hello", makeConfig(home, { reasoningDefault: "on" }));

      expect(lastRunCall().reasoningLevel).toBe("on");
    });
  });

  it("per-agent reasoningDefault overrides agents.defaults.reasoningDefault", async () => {
    await withTempHome(async (home) => {
      mockReasoningCapableCatalog();
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));
      const base = makeConfig(home, { reasoningDefault: "on" });
      const config = {
        ...base,
        agents: {
          ...base.agents,
          list: [{ id: "main", default: true, reasoningDefault: "off" }],
        },
      };

      await sendSignal(home, "hello", config);

      expect(lastRunCall().reasoningLevel).toBe("off");
    });
  });

  it("session /reasoning off still wins over a configured reasoningDefault (§2.3)", async () => {
    await withTempHome(async (home) => {
      mockReasoningCapableCatalog();
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));
      const config = makeConfig(home, { reasoningDefault: "on" });

      await sendSignal(home, "/reasoning off", config);
      await sendSignal(home, "hello", config);

      expect(lastRunCall().reasoningLevel).toBe("off");
    });
  });

  it("other channel surfaces (WhatsApp, Discord, Telegram) also stay off", async () => {
    await withTempHome(async (home) => {
      mockReasoningCapableCatalog();
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));
      const config = makeConfig(
        home,
        {},
        {
          channels: {
            whatsapp: { allowFrom: ["*"] },
            discord: { allowFrom: ["*"] },
            telegram: { allowFrom: ["*"] },
          },
        },
      );

      for (const channel of ["whatsapp", "discord", "telegram"] as const) {
        runEmbeddedPiAgentMock.mockClear();
        await getReplyFromConfig(
          {
            Body: "hello",
            From: `${channel}:user:1004`,
            To: `${channel}:bot`,
            Provider: channel,
            Surface: channel,
            OriginatingChannel: channel,
            CommandAuthorized: true,
          },
          {},
          config,
        );
        expect(lastRunCall().reasoningLevel, channel).toBe("off");
      }
    });
  });

  it("non-channel surface with a reasoning-capable model and nothing set: catalog default (unchanged)", async () => {
    await withTempHome(async (home) => {
      mockReasoningCapableCatalog();
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "webchat:client",
          To: "webchat:agent",
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          CommandAuthorized: true,
        },
        {},
        makeConfig(home),
      );

      const call = lastRunCall();
      expect(call.thinkLevel).toBe("off");
      expect(call.reasoningLevel).toBe("on");
    });
  });

  it("direct pipeline call with no channel surface (CLI-style) keeps the catalog default (unchanged)", async () => {
    await withTempHome(async (home) => {
      mockReasoningCapableCatalog();
      runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult("done"));

      await getReplyFromConfig({ Body: "hello", From: "+1004", To: "+2000" }, {}, makeConfig(home));

      expect(lastRunCall().reasoningLevel).toBe("on");
    });
  });
});
