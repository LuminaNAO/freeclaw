import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

// no-reply-tool §5.1: only cron runs with delivery have a reply target; §4.2: a silent run delivers nothing.

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "no-reply",
      name: "No Reply",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check things" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    } as never,
    message: "check things",
    sessionKey: "cron:no-reply",
  };
}

describe("runCronIsolatedAgentTurn and no_reply", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("marks cron runs with delivery as having a reply target, others not", async () => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.hasReplyTarget).toBe(true);

    runEmbeddedPiAgentMock.mockClear();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
    await runCronIsolatedAgentTurn(makeParams());
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.hasReplyTarget).toBe(false);
  });

  it("a silent run delivers nothing and counts as handled", async () => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: undefined,
      meta: { durationMs: 1, agentMeta: { usage: { input: 1, output: 1 } } },
      silent: true,
    });
    const result = await runCronIsolatedAgentTurn(makeParams());
    expect(result.status).toBe("ok");
    expect(result.delivered).toBe(true);
    expect(result.error).toBeUndefined();
    // No interim-ack continuation turn.
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
  });
});
