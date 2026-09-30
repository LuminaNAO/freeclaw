import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCompactionFailureError, isLikelyContextOverflowError } from "../pi-embedded-helpers.js";

vi.mock(import("../../utils.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveUserPath: vi.fn((p: string) => p),
  };
});

import { NO_AGENT_TIMEOUT_MS } from "../timeout.js";
import { log } from "./logger.js";
import { runEmbeddedPiAgent } from "./run.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
  mockOverflowRetrySuccess,
  queueOverflowAttemptWithOversizedToolOutput,
} from "./run.overflow-compaction.fixture.js";
import {
  mockedContextEngine,
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.shared-test.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const mockedIsCompactionFailureError = vi.mocked(isCompactionFailureError);
const mockedIsLikelyContextOverflowError = vi.mocked(isLikelyContextOverflowError);

describe("overflow compaction in run loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRunEmbeddedAttempt.mockReset();
    mockedCompactDirect.mockReset();
    mockedSessionLikelyHasOversizedToolResults.mockReset();
    mockedTruncateOversizedToolResultsInSession.mockReset();
    mockedContextEngine.info.ownsCompaction = false;
    mockedIsCompactionFailureError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    });
    mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return (
        lower.includes("request_too_large") ||
        lower.includes("request size exceeds") ||
        lower.includes("context window exceeded") ||
        lower.includes("prompt too large")
      );
    });
    mockedCompactDirect.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized tool results",
    });
  });

  it("retries after successful compaction on context overflow promptError", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({ authProfileId: "test-profile" }),
      }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "context overflow detected (attempt 1/3); attempting auto-compaction",
      ),
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("auto-compaction succeeded"));
    // Should not be an error result
    expect(result.meta.error).toBeUndefined();
  });

  it("retries after successful compaction on likely-overflow promptError variants", async () => {
    const overflowHintError = new Error("Context window exceeded: requested 12000 tokens");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowHintError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-6",
        tokensBefore: 140000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("source=promptError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("returns error if compaction fails", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("auto-compaction failed"));
  });

  it("falls back to tool-result truncation and retries when oversized results are detected", async () => {
    queueOverflowAttemptWithOversizedToolOutput(mockedRunEmbeddedAttempt, makeOverflowError());
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedSessionLikelyHasOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindowTokens: 200000 }),
    );
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Truncated 1 tool result(s)"));
    expect(result.meta.error).toBeUndefined();
  });

  it("retries compaction up to 3 times before giving up", async () => {
    const overflowError = makeOverflowError();

    // 4 overflow errors: 3 compaction retries + final failure
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 1",
          firstKeptEntryId: "entry-3",
          tokensBefore: 180000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 2",
          firstKeptEntryId: "entry-5",
          tokensBefore: 160000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 3",
          firstKeptEntryId: "entry-7",
          tokensBefore: 140000,
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    // Compaction attempted 3 times (max)
    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    // 4 attempts: 3 overflow+compact+retry cycles + final overflow → error
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("succeeds after second compaction attempt", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 1",
          firstKeptEntryId: "entry-3",
          tokensBefore: 180000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 2",
          firstKeptEntryId: "entry-5",
          tokensBefore: 160000,
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.error).toBeUndefined();
  });

  it("does not attempt compaction for compaction_failure errors", async () => {
    const compactionFailureError = new Error(
      "request_too_large: summarization failed - Request size exceeds model context window",
    );

    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ promptError: compactionFailureError }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("compaction_failure");
  });

  it("retries after successful compaction on assistant context overflow errors", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: {
            stopReason: "error",
            errorMessage: "request_too_large: Request size exceeds model context window",
          } as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("does not treat stale assistant overflow as current-attempt overflow when promptError is non-overflow", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("transport disconnected"),
        lastAssistant: {
          stopReason: "error",
          errorMessage: "request_too_large: Request size exceeds model context window",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow("transport disconnected");

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
  });

  it("returns an explicit timeout payload when the run times out before producing any reply", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: [],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("reports a stall abort honestly instead of an LLM request timeout", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        abortKind: "stall",
        abortLimitMs: 600_000,
        assistantTexts: [],
        lastAssistant: {
          stopReason: "error",
          errorMessage: "request timed out",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    const texts = (result.payloads ?? []).map((p) => p.text ?? "");
    expect(texts).toEqual(["No progress for 600s (stalled); run aborted."]);
    expect(texts.join("\n")).not.toMatch(/LLM request timed out/i);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("reports a configured run limit honestly and does not fall back to another model", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        abortKind: "run-limit",
        abortLimitMs: 900_000,
        assistantTexts: [],
        lastAssistant: {
          stopReason: "error",
          errorMessage: "request timed out",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      config: {
        agents: {
          defaults: { model: { primary: "anthropic/test-model", fallbacks: ["openai/gpt-5.2"] } },
        },
      },
    });

    const texts = (result.payloads ?? []).map((p) => p.text ?? "");
    expect(texts).toEqual(["Run exceeded configured limit of 900s and was stopped."]);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("still reports a stall honestly when it lands during compaction", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: true,
        abortKind: "stall",
        abortLimitMs: 600_000,
        assistantTexts: ["partial answer"],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    const texts = (result.payloads ?? []).map((p) => p.text ?? "");
    expect(texts).toContain("No progress for 600s (stalled); run aborted.");
    expect(texts.join("\n")).not.toMatch(/LLM request timed out/i);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("treats an explicit limit as a whole-run deadline across retry attempts", async () => {
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return makeAttemptResult({ promptError: makeOverflowError() });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({ summary: "c", firstKeptEntryId: "e", tokensBefore: 1 }),
    );

    await runEmbeddedPiAgent({ ...baseParams, timeoutMs: 30_000 });

    const [first, second] = mockedRunEmbeddedAttempt.mock.calls.map(
      (c) => c[0] as { timeoutMs: number; runLimitMs?: number },
    );
    expect(first?.runLimitMs).toBe(30_000);
    expect(second?.runLimitMs).toBe(30_000);
    expect(first?.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(second?.timeoutMs).toBeLessThanOrEqual(30_000 - 50);
  });

  it("stops a hung overflow compaction at the configured run limit and cancels it", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: makeOverflowError() }),
    );
    let compactSignal: AbortSignal | undefined;
    mockedContextEngine.compact.mockImplementationOnce(
      (params: unknown) =>
        new Promise((_, reject) => {
          compactSignal = (params as { abortSignal?: AbortSignal }).abortSignal;
          compactSignal?.addEventListener("abort", () => reject(new Error("compaction aborted")));
        }),
    );

    const result = await runEmbeddedPiAgent({ ...baseParams, timeoutMs: 200 });

    expect(result.meta.aborted).toBe(true);
    expect(result.payloads?.map((p) => p.text)).toEqual([
      "Run exceeded configured limit of 0s and was stopped.",
    ]);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(compactSignal?.aborted).toBe(true);
  });

  it("stops an attempt whose setup hangs before its watchdogs are armed", async () => {
    let setupSignal: AbortSignal | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(
      (params) =>
        new Promise((_, reject) => {
          setupSignal = (params as { setupAbortSignal?: AbortSignal }).setupAbortSignal;
          setupSignal?.addEventListener("abort", () => reject(new Error("setup aborted")));
        }),
    );

    const result = await runEmbeddedPiAgent({ ...baseParams, timeoutMs: 150, runLimitMs: 60_000 });

    expect(result.meta.aborted).toBe(true);
    expect(result.payloads?.[0]?.text).toBe(
      "Run exceeded configured limit of 60s and was stopped.",
    );
    expect(setupSignal?.aborted).toBe(true);
  });

  it("counts time before the run starts (queue wait) against an absolute run deadline", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    // The caller's deadline was fixed 20 s ago (queue wait, earlier fallback candidates).
    await runEmbeddedPiAgent({
      ...baseParams,
      timeoutMs: 60_000,
      runLimitMs: 60_000,
      runDeadlineAtMs: Date.now() + 40_000,
    });

    const call = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as { timeoutMs: number };
    expect(call.timeoutMs).toBeLessThanOrEqual(40_000);
    expect(call.timeoutMs).toBeGreaterThan(39_000);
  });

  it("passes the uncapped sentinel through unchanged when no limit is configured", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({ ...baseParams, timeoutMs: NO_AGENT_TIMEOUT_MS });

    const call = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as { timeoutMs: number };
    expect(call.timeoutMs).toBe(NO_AGENT_TIMEOUT_MS);
  });

  it("sets promptTokens from the latest model call usage, not accumulated attempt usage", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        attemptUsage: {
          input: 4_000,
          cacheRead: 120_000,
          cacheWrite: 0,
          total: 124_000,
        },
        lastAssistant: {
          stopReason: "end_turn",
          usage: {
            input: 900,
            cacheRead: 1_100,
            cacheWrite: 0,
            total: 2_000,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.meta.agentMeta?.usage?.input).toBe(4_000);
    expect(result.meta.agentMeta?.promptTokens).toBe(2_000);
  });
});
