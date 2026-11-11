import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/config.js";
import { getLastHeartbeatEvent } from "./heartbeat-events.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

// no-reply-tool §4.6 / §8.10: a heartbeat run that ends with `no_reply` is the ack. runReplyAgent turns
// the silent run into the HEARTBEAT_OK reply (agent-runner.no-reply.test.ts); here the heartbeat runner
// treats that exactly like a model-written HEARTBEAT_OK: nothing posted, "ok-token" outcome.

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

installHeartbeatRunnerTestRuntime();

const WHATSAPP_GROUP = "120363140186826074@g.us";

async function runWith(reply: {
  text: string;
}): Promise<{ event: ReturnType<typeof getLastHeartbeatEvent>; sends: number }> {
  const outcome: { event: ReturnType<typeof getLastHeartbeatEvent>; sends: number } = {
    event: null,
    sends: 0,
  };
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "whatsapp" } } },
      channels: { whatsapp: { allowFrom: ["*"] } } as never,
      session: { store: storePath },
    };
    await seedMainSessionStore(storePath, cfg, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: WHATSAPP_GROUP,
    });
    replySpy.mockResolvedValue(reply);
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });
    await runHeartbeatOnce({
      cfg,
      deps: {
        sendWhatsApp: sendWhatsApp as unknown as HeartbeatDeps["sendWhatsApp"],
        getQueueSize: () => 0,
        nowMs: () => 0,
        webAuthExists: async () => true,
        hasActiveWebListener: () => true,
      },
    });
    outcome.sends = sendWhatsApp.mock.calls.length;
    outcome.event = getLastHeartbeatEvent();
  });
  return outcome;
}

describe("heartbeat ack via no_reply", () => {
  it("§8.10 the silent run's ack has the same outcome as a HEARTBEAT_OK reply", async () => {
    const viaTool = await runWith({ text: HEARTBEAT_TOKEN });
    const viaToken = await runWith({ text: "HEARTBEAT_OK" });

    expect(viaTool.sends).toBe(0);
    expect(viaTool.event?.status).toBe("ok-token");
    expect(viaTool.event?.status).toBe(viaToken.event?.status);
    expect(viaTool.sends).toBe(viaToken.sends);
  });
});
