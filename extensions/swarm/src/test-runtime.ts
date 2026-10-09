import { vi } from "vitest";

/** Stub plugin runtime that records every subagent call. Generic placeholders only. */
export type RecordedRun = {
  sessionKey: string;
  message: string;
  idempotencyKey?: string;
  lane?: string;
  deliver?: boolean;
  extraSystemPrompt?: string;
};

export function makeStubRuntime(
  opts: {
    failRuns?: number;
    runError?: string;
    /** Per session: message text, or text plus a message timestamp (epoch ms). */
    transcripts?: Record<string, Array<string | { text: string; timestamp: number }>>;
    patchFails?: Record<string, string>;
  } = {},
) {
  const runs: RecordedRun[] = [];
  const patches: Array<{
    sessionKey: string;
    model?: string;
    thinkingLevel?: string;
    label?: string;
  }> = [];
  const aborts: string[] = [];
  /**
   * Session store stand-in: one session id per session key, created on first use (patch or
   * run) and kept, as the gateway keeps a session entry's id. `runSessionIds[i]` is the id
   * runs[i] ran in, so tests can assert "same session" by id, not only by key.
   */
  const sessionIds = new Map<string, string>();
  const runSessionIds: string[] = [];
  const sessionIdFor = (sessionKey: string) => {
    let id = sessionIds.get(sessionKey);
    if (!id) {
      id = `session-${sessionIds.size + 1}`;
      sessionIds.set(sessionKey, id);
    }
    return id;
  };
  let failuresLeft = opts.failRuns ?? 0;
  type WaitResult = { status: "ok" | "error" | "timeout"; error?: string };
  /** Runs started and not settled yet: runId → session key and the agent.wait resolver. */
  const live = new Map<string, { sessionKey: string; settle: (r: WaitResult) => void }>();
  const waits = new Map<string, Promise<WaitResult>>();
  /** Max runs ever live at once in one session (ARCH §5: must stay 1). */
  const maxLive = new Map<string, number>();
  const subagent = {
    run: vi.fn(async (params: RecordedRun) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error(opts.runError ?? "gateway unavailable");
      }
      runs.push(params);
      runSessionIds.push(sessionIdFor(params.sessionKey));
      const runId = params.idempotencyKey ?? `run-${runs.length}`;
      waits.set(
        runId,
        new Promise<WaitResult>((settle) =>
          live.set(runId, { sessionKey: params.sessionKey, settle }),
        ),
      );
      const n = [...live.values()].filter((r) => r.sessionKey === params.sessionKey).length;
      maxLive.set(params.sessionKey, Math.max(maxLive.get(params.sessionKey) ?? 0, n));
      return { runId };
    }),
    /** agent.wait: resolves when the test ends the run (or never, for a run left going). */
    waitForRun: vi.fn(async (params: { runId: string }) => {
      return (await waits.get(params.runId)) ?? { status: "ok" as const };
    }),
    getSessionMessages: vi.fn(async (params: { sessionKey: string }) => ({
      messages: (opts.transcripts?.[params.sessionKey] ?? []).map((m) =>
        typeof m === "string"
          ? { role: "user", content: m }
          : { role: "assistant", content: m.text, timestamp: m.timestamp },
      ),
    })),
    patchSession: vi.fn(
      async (params: {
        sessionKey: string;
        model?: string;
        thinkingLevel?: string;
        label?: string;
      }) => {
        const failure = params.model ? opts.patchFails?.[params.model] : undefined;
        if (failure) {
          throw new Error(failure);
        }
        patches.push(params);
        sessionIdFor(params.sessionKey);
        const [provider = "default", ...rest] = (params.model ?? "default/default").split("/");
        return { provider, model: rest.join("/") || "default" };
      },
    ),
    abortSession: vi.fn(async (params: { sessionKey: string }) => {
      aborts.push(params.sessionKey);
      for (const [runId, r] of live) {
        if (r.sessionKey === params.sessionKey) {
          live.delete(runId);
          r.settle({ status: "timeout" });
        }
      }
      return { aborted: true };
    }),
  };
  /** Let every pending promise chain (mailbox release, flush, routing) run to the end. */
  const drain = () => new Promise((r) => setTimeout(r, 0));
  /** End the live run in a session, as the gateway's agent.wait would report it. */
  async function end(sessionKey: string, result: WaitResult = { status: "ok" }) {
    const found = [...live].find(([, r]) => r.sessionKey === sessionKey);
    if (found) {
      live.delete(found[0]);
      found[1].settle(result);
    }
    await drain();
    await drain();
  }
  /** End every live run, repeatedly, until none is left (or the guard trips). */
  async function endAll() {
    for (let guard = 0; guard < 50 && live.size > 0; guard += 1) {
      await end([...live.values()][0]!.sessionKey);
    }
  }
  const liveIn = (sessionKey: string) =>
    [...live.values()].filter((r) => r.sessionKey === sessionKey).length;
  return {
    runs,
    runSessionIds,
    sessionIds,
    patches,
    aborts,
    subagent,
    end,
    endAll,
    drain,
    liveIn,
    maxLive,
  };
}
