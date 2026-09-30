import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runCliAgentMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — whole-run deadline", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("gives a fallback candidate only what is left of the configured limit", async () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      await new Promise((r) => setTimeout(r, 60));
      const result = await run("anthropic", "claude-sonnet-4-6");
      return { result, provider: "anthropic", model: "claude-sonnet-4-6", attempts: [] };
    });

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload: { kind: "agentTurn", message: "test" } }),
      }),
    );

    const calls = runEmbeddedPiAgentMock.mock.calls.map(
      (c) => c[0] as { timeoutMs: number; runLimitMs?: number },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.runLimitMs).toBe(60_000);
    expect(calls[1]?.runLimitMs).toBe(60_000);
    expect(calls[1]?.timeoutMs).toBeLessThanOrEqual(60_000 - 50);
    expect(calls[1]?.timeoutMs).toBeLessThan(calls[0]?.timeoutMs ?? 0);
  });
});

describe("runCronIsolatedAgentTurn — CLI abort propagation", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("passes the cron abort signal and run deadline to CLI runs", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockRunCronFallbackPassthrough();
    const controller = new AbortController();

    await runCronIsolatedAgentTurn({
      ...makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ payload: { kind: "agentTurn", message: "test" } }),
      }),
      abortSignal: controller.signal,
    });

    const call = runCliAgentMock.mock.calls[0]?.[0] as {
      abortSignal?: AbortSignal;
      runLimitMs?: number;
      timeoutMs: number;
    };
    expect(call.abortSignal).toBe(controller.signal);
    expect(call.runLimitMs).toBe(60_000);
    expect(call.timeoutMs).toBeLessThanOrEqual(60_000);
  });
});
