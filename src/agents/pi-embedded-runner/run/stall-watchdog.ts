export type StallWatchdog = {
  /** Record progress (stream delta, tool start/update/end, compaction, tool output). */
  touch: () => void;
  idleMs: () => number;
  stop: () => void;
};

/**
 * Aborts a run only when nothing has happened for `idleTimeoutMs`. Every session event (stream delta, tool
 * start/update/end, compaction) and every chunk of this run's exec output calls `touch()`. While `isToolAlive()`
 * reports an exec process started by this run (a long foreground exec, or a background job the model is waiting
 * on), the run also counts as progressing without new output, even after the exec tool call returned.
 */
export function createStallWatchdog(params: {
  idleTimeoutMs: number;
  onStall: (idleMs: number) => void;
  isToolAlive?: () => boolean;
  checkIntervalMs?: number;
  now?: () => number;
}): StallWatchdog {
  const now = params.now ?? Date.now;
  let lastProgressAt = now();
  let fired = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const touch = () => {
    lastProgressAt = now();
  };

  if (params.idleTimeoutMs > 0) {
    const interval =
      params.checkIntervalMs ??
      Math.max(250, Math.min(5_000, Math.floor(params.idleTimeoutMs / 4)));
    timer = setInterval(() => {
      if (fired) {
        return;
      }
      if (params.isToolAlive?.()) {
        touch();
        return;
      }
      const idle = now() - lastProgressAt;
      if (idle >= params.idleTimeoutMs) {
        fired = true;
        clearInterval(timer);
        params.onStall(idle);
      }
    }, interval);
    timer.unref?.();
  }

  return {
    touch,
    idleMs: () => now() - lastProgressAt,
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export type RunAbortKind = "run-limit" | "stall";

// User-facing copy must not contain "timeout"/"timed out": the provider-error formatter would
// otherwise rewrite it to the generic "LLM request timed out." (see ERROR_PATTERNS.timeout).
export function formatRunLimitMessage(limitMs: number): string {
  return `Run exceeded configured limit of ${Math.round(limitMs / 1000)}s and was stopped.`;
}

export function formatStallMessage(idleLimitMs: number): string {
  return `No progress for ${Math.round(idleLimitMs / 1000)}s (stalled); run aborted.`;
}

/** Our own watchdog stopped work that runs between attempts (for example recovery compaction). */
export class RunWatchdogAbort extends Error {
  constructor(
    readonly kind: RunAbortKind,
    readonly limitMs: number,
  ) {
    super(kind === "stall" ? formatStallMessage(limitMs) : formatRunLimitMessage(limitMs));
    this.name = "RunWatchdogAbort";
  }
}

/**
 * Bound work that happens outside an attempt (no stream/tool events): it may use at most the idle window
 * and never past the whole-run deadline. `remainingMs` of NO_AGENT_TIMEOUT_MS or more means uncapped.
 */
export async function guardBetweenAttempts<T>(
  work: Promise<T>,
  params: { remainingMs: number; runLimitMs: number; idleTimeoutMs: number; capped: boolean },
): Promise<T> {
  const limits: Array<{ ms: number; abort: () => RunWatchdogAbort }> = [];
  if (params.capped) {
    limits.push({
      ms: Math.max(1, params.remainingMs),
      abort: () => new RunWatchdogAbort("run-limit", params.runLimitMs),
    });
  }
  if (params.idleTimeoutMs > 0) {
    limits.push({
      ms: params.idleTimeoutMs,
      abort: () => new RunWatchdogAbort("stall", params.idleTimeoutMs),
    });
  }
  if (limits.length === 0) {
    return await work;
  }
  const first = limits.reduce((a, b) => (b.ms < a.ms ? b : a));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(first.abort()), first.ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Attempt setup (session load, context engine bootstrap/assemble, hooks) runs before the attempt installs its
 * own watchdogs. Bound that phase like recovery work; once `armed()` is called the attempt owns the limits.
 * When the setup guard fires, `signal` is aborted so the attempt stops at its next setup checkpoint, and the
 * returned promise only settles once the attempt itself has finished (no detached work after we return).
 */
const SETUP_ABORT_GRACE_MS = 30_000;

/**
 * Like guardBetweenAttempts, but for work that can be cancelled: `start` receives a signal that is aborted when
 * a limit fires, and we wait (bounded) for the work to stop before reporting, so it does not keep mutating the
 * session or use a disposed context engine after the run returned.
 */
export async function guardCancellableWork<T>(
  start: (signal: AbortSignal) => Promise<T>,
  params: { remainingMs: number; runLimitMs: number; idleTimeoutMs: number; capped: boolean },
): Promise<T> {
  const controller = new AbortController();
  const work = start(controller.signal);
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await guardBetweenAttempts(work, params);
  } catch (err) {
    if (err instanceof RunWatchdogAbort) {
      controller.abort(err);
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, SETUP_ABORT_GRACE_MS);
          graceTimer.unref?.();
        }),
      ]);
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
    }
    throw err;
  }
}

export async function raceAttemptSetup<T>(
  start: (armed: () => void, signal: AbortSignal) => Promise<T>,
  params: { remainingMs: number; runLimitMs: number; idleTimeoutMs: number; capped: boolean },
): Promise<T> {
  const controller = new AbortController();
  let disarm: () => void = () => {};
  const setupDone = new Promise<void>((resolve) => {
    disarm = resolve;
  });
  const attempt = start(() => disarm(), controller.signal);
  // Both promises are always observed below, so neither can surface as an unhandled rejection.
  const attemptSettled = attempt.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let guardAbort: RunWatchdogAbort | undefined;
  const guard = guardBetweenAttempts(setupDone, params).then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof RunWatchdogAbort) {
        guardAbort = error;
        controller.abort(error);
      }
    },
  );
  const first = await Promise.race([attemptSettled, guard.then(() => undefined)]);
  disarm();
  if (first === undefined && guardAbort) {
    // Setup overran: give the attempt a bounded moment to unwind at its next checkpoint (it sees the aborted
    // signal and releases locks), then report the limit even if some third-party await ignores the signal.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      attemptSettled,
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, SETUP_ABORT_GRACE_MS);
        graceTimer.unref?.();
      }),
    ]);
    if (graceTimer) {
      clearTimeout(graceTimer);
    }
    throw guardAbort;
  }
  const outcome = first ?? (await attemptSettled);
  if (!outcome.ok) {
    // An attempt that failed because we aborted its setup is reported as the watchdog limit it hit.
    throw guardAbort ?? outcome.error;
  }
  return outcome.value;
}
