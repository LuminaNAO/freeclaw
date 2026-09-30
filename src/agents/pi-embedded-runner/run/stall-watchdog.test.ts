import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAssistantErrorText, isTimeoutErrorMessage } from "../../pi-embedded-helpers.js";
import {
  createStallWatchdog,
  formatRunLimitMessage,
  formatStallMessage,
  guardBetweenAttempts,
  raceAttemptSetup,
  RunWatchdogAbort,
} from "./stall-watchdog.js";

describe("createStallWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the idle window with no progress", () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ idleTimeoutMs: 10_000, onStall, checkIntervalMs: 1_000 });
    vi.advanceTimersByTime(9_000);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    wd.stop();
  });

  it("progress resets the window, so a long but active run is never aborted", () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ idleTimeoutMs: 10_000, onStall, checkIntervalMs: 1_000 });
    // 31 model calls of ~15s each, streaming every few seconds: ~8 minutes, well past any cap.
    for (let i = 0; i < 31 * 5; i += 1) {
      vi.advanceTimersByTime(3_000);
      wd.touch();
    }
    expect(onStall).not.toHaveBeenCalled();
    wd.stop();
  });

  it("a live tool process counts as progress while the tool is in flight", () => {
    const onStall = vi.fn();
    let alive = true;
    const wd = createStallWatchdog({
      idleTimeoutMs: 10_000,
      onStall,
      checkIntervalMs: 1_000,
      isToolAlive: () => alive,
    });
    wd.touch();
    // Silent 23-minute poll on a live process.
    vi.advanceTimersByTime(23 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(11_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    wd.stop();
  });

  it("a live background process counts as progress after the exec tool returned", () => {
    const onStall = vi.fn();
    let alive = true;
    const wd = createStallWatchdog({
      idleTimeoutMs: 10_000,
      onStall,
      checkIntervalMs: 1_000,
      isToolAlive: () => alive,
    });
    wd.touch();
    // Model quiet for 23 minutes while the background job runs.
    vi.advanceTimersByTime(23 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(11_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    wd.stop();
  });

  it("idleTimeoutMs=0 disables the watchdog", () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ idleTimeoutMs: 0, onStall });
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
    wd.stop();
  });

  it("stop prevents a later stall", () => {
    const onStall = vi.fn();
    const wd = createStallWatchdog({ idleTimeoutMs: 10_000, onStall, checkIntervalMs: 1_000 });
    wd.stop();
    vi.advanceTimersByTime(60_000);
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe("abort messages", () => {
  it("are distinct and never claim an LLM request timed out", () => {
    const limit = formatRunLimitMessage(900_000);
    const stall = formatStallMessage(600_000);
    expect(limit).toBe("Run exceeded configured limit of 900s and was stopped.");
    expect(stall).toBe("No progress for 600s (stalled); run aborted.");
  });

  it("survive the provider-error formatter unchanged", () => {
    for (const text of [formatRunLimitMessage(900_000), formatStallMessage(600_000)]) {
      expect(isTimeoutErrorMessage(text), text).toBe(false);
      const msg = {
        role: "assistant",
        stopReason: "error",
        errorMessage: text,
        content: [],
      } as unknown as AssistantMessage;
      expect(formatAssistantErrorText(msg)).toBe(text);
    }
  });
});

describe("resolveAttemptIdleTimeoutMs", () => {
  it("applies the 10 minute default regardless of provider (local included)", async () => {
    const { resolveAttemptIdleTimeoutMs } = await import("./attempt.js");
    expect(resolveAttemptIdleTimeoutMs({ config: {} })).toBe(600_000);
    expect(resolveAttemptIdleTimeoutMs({ config: undefined })).toBe(600_000);
    expect(resolveAttemptIdleTimeoutMs({ config: {}, idleTimeoutMs: 0 })).toBe(0);
  });
});

describe("guardBetweenAttempts / raceAttemptSetup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = () => new Promise<never>(() => {});

  it("stops hung recovery work at the idle window", async () => {
    const guarded = guardBetweenAttempts(never(), {
      capped: false,
      remainingMs: 0,
      runLimitMs: 0,
      idleTimeoutMs: 600_000,
    });
    const assertion = expect(guarded).rejects.toMatchObject({ kind: "stall", limitMs: 600_000 });
    await vi.advanceTimersByTimeAsync(600_001);
    await assertion;
  });

  it("stops hung recovery work at the remaining run limit when that comes first", async () => {
    const guarded = guardBetweenAttempts(never(), {
      capped: true,
      remainingMs: 1_000,
      runLimitMs: 30_000,
      idleTimeoutMs: 600_000,
    });
    const assertion = expect(guarded).rejects.toBeInstanceOf(RunWatchdogAbort);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    await expect(guarded).rejects.toThrow("Run exceeded configured limit of 30s");
  });

  it("does not bound uncapped work with idle disabled", async () => {
    let done = false;
    const work = new Promise<string>((r) => setTimeout(() => r("ok"), 24 * 3_600_000));
    const guarded = guardBetweenAttempts(work, {
      capped: false,
      remainingMs: 0,
      runLimitMs: 0,
      idleTimeoutMs: 0,
    }).then((v) => {
      done = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    await expect(guarded).resolves.toBe("ok");
    expect(done).toBe(true);
  });

  it("aborts the attempt's setup signal and reports the stall when setup never arms", async () => {
    let seenSignal: AbortSignal | undefined;
    const raced = raceAttemptSetup(
      (_armed, signal) => {
        seenSignal = signal;
        // A cooperative setup rejects as soon as its signal aborts.
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("setup aborted")));
        });
      },
      { capped: false, remainingMs: 0, runLimitMs: 0, idleTimeoutMs: 600_000 },
    );
    const assertion = expect(raced).rejects.toMatchObject({ kind: "stall" });
    await vi.advanceTimersByTimeAsync(600_001);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
  });

  it("gives up waiting for an uncooperative setup after a bounded grace", async () => {
    const raced = raceAttemptSetup(() => never(), {
      capped: false,
      remainingMs: 0,
      runLimitMs: 0,
      idleTimeoutMs: 600_000,
    });
    const assertion = expect(raced).rejects.toMatchObject({ kind: "stall" });
    await vi.advanceTimersByTimeAsync(600_001 + 30_000);
    await assertion;
  });

  it("surfaces an attempt rejection once, with no unhandled rejection left behind", async () => {
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        raceAttemptSetup(() => Promise.reject(new Error("boom")), {
          capped: true,
          remainingMs: 60_000,
          runLimitMs: 60_000,
          idleTimeoutMs: 600_000,
        }),
      ).rejects.toThrow("boom");
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stops guarding once the attempt arms its watchdogs", async () => {
    const raced = raceAttemptSetup(
      (armed) =>
        new Promise<string>((resolve) => {
          setTimeout(armed, 1_000);
          setTimeout(() => resolve("done"), 60 * 60_000);
        }),
      { capped: false, remainingMs: 0, runLimitMs: 0, idleTimeoutMs: 600_000 },
    );
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(raced).resolves.toBe("done");
  });
});

describe("isOutputFromThisRun", () => {
  it("ignores output from a job started before this run or in another scope", async () => {
    const { isOutputFromThisRun } = await import("./attempt.js");
    expect(isOutputFromThisRun({ scopeKey: "s", startedAt: 2_000 }, "s", 1_000)).toBe(true);
    expect(isOutputFromThisRun({ scopeKey: "s", startedAt: 500 }, "s", 1_000)).toBe(false);
    expect(isOutputFromThisRun({ scopeKey: "other", startedAt: 2_000 }, "s", 1_000)).toBe(false);
  });
});
