import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Design: docs/design/subagent-archive.md. Archiving is cleanup of FINISHED runs; it must never end a live run.

type LifecycleEvent = {
  stream?: string;
  runId: string;
  data?: { phase?: string; startedAt?: number; endedAt?: number; aborted?: boolean };
};
type WaitResult = { status?: string; startedAt?: number; endedAt?: number; error?: string };
type GatewayRequest = { method?: string; params?: Record<string, unknown> };

const MINUTE_MS = 60_000;
const ARCHIVE_AFTER_MINUTES = 60;
const ARCHIVE_AFTER_MS = ARCHIVE_AFTER_MINUTES * MINUTE_MS;
const MAIN_KEY = "agent:main:main";

let lifecycleHandler: ((evt: LifecycleEvent) => void) | undefined;
const pendingWait = () => new Promise<WaitResult>(() => undefined);
let agentWaitImpl: (params: Record<string, unknown>) => Promise<WaitResult> = pendingWait;

const callGatewayMock = vi.fn(async (request: GatewayRequest) => {
  if (request.method === "agent.wait") {
    return await agentWaitImpl(request.params ?? {});
  }
  return {};
});
const announceSpy = vi.fn(async (_params?: Record<string, unknown>) => true);
const loadRegistryMock = vi.fn(() => new Map<string, SubagentRunRecord>());

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return () => {};
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: ARCHIVE_AFTER_MINUTES } } },
  })),
}));

vi.mock("../config/sessions.js", () => {
  // Every child session exists, so restored runs are not pruned as orphans.
  const sessionStore = new Proxy<Record<string, { sessionId: string; updatedAt: number }>>(
    {},
    {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return { sessionId: `sess-${prop}`, updatedAt: 1 };
      },
    },
  );
  return {
    loadSessionStore: vi.fn(() => sessionStore),
    resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
    resolveMainSessionKey: () => MAIN_KEY,
    resolveStorePath: () => "/tmp/test-store",
    updateSessionStore: vi.fn(),
  };
});

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
  captureSubagentCompletionReply: vi.fn(async () => "final answer"),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: loadRegistryMock,
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent archive never kills a live run", () => {
  let mod: typeof import("./subagent-registry.js");
  let runtime: typeof import("../runtime.js");
  let timeout: typeof import("./timeout.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
    runtime = await import("../runtime.js");
    timeout = await import("./timeout.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
    callGatewayMock.mockClear();
    announceSpy.mockClear();
    announceSpy.mockResolvedValue(true);
    loadRegistryMock.mockReset();
    loadRegistryMock.mockReturnValue(new Map());
    agentWaitImpl = pendingWait;
    lifecycleHandler = undefined;
  });

  afterEach(() => {
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const flush = async () => {
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
  };

  const register = (
    runId: string,
    childSessionKey: string,
    extra: { runTimeoutSeconds?: number } = {},
  ) => {
    mod.registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: MAIN_KEY,
      requesterDisplayKey: "main",
      task: `task ${runId}`,
      cleanup: "keep",
      spawnMode: "run",
      ...extra,
    });
  };

  const findRun = (runId: string) =>
    mod.listSubagentRunsForRequester(MAIN_KEY).find((entry) => entry.runId === runId);

  const endRun = async (runId: string, endedAt = Date.now()) => {
    lifecycleHandler?.({ stream: "lifecycle", runId, data: { phase: "end", endedAt } });
    await flush();
    return endedAt;
  };

  const deletedKeys = () =>
    callGatewayMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "sessions.delete")
      .map((request) => request.params?.key);

  const agentWaitCalls = () =>
    callGatewayMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "agent.wait");

  it("keeps a run-mode child working past archiveAfterMinutes, then archives it archiveAfterMinutes after it ended", async () => {
    const child = "agent:main:subagent:long";
    register("run-long", child);
    await flush();

    // A run that has not ended has no archive time (item 1).
    expect(findRun("run-long")?.archiveAtMs).toBeUndefined();

    await vi.advanceTimersByTimeAsync(ARCHIVE_AFTER_MS + 5 * MINUTE_MS);
    expect(deletedKeys()).toEqual([]);
    expect(findRun("run-long")?.endedAt).toBeUndefined();

    const endedAt = await endRun("run-long");
    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(announceSpy.mock.calls[0]?.[0]).toMatchObject({ childRunId: "run-long" });
    expect(findRun("run-long")?.archiveAtMs).toBe(endedAt + ARCHIVE_AFTER_MS);

    await vi.advanceTimersByTimeAsync(ARCHIVE_AFTER_MS - 2 * MINUTE_MS);
    expect(deletedKeys()).toEqual([]);
    expect(findRun("run-long")).toBeDefined();

    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
    expect(deletedKeys()).toEqual([child]);
    const deleteCall = callGatewayMock.mock.calls.find(
      ([request]) => request.method === "sessions.delete",
    )?.[0];
    expect(deleteCall?.params).toMatchObject({ key: child, deleteTranscript: true });
    expect(findRun("run-long")).toBeUndefined();
  });

  it("archives a run that finished right away archiveAfterMinutes later (unchanged)", async () => {
    const child = "agent:main:subagent:quick";
    register("run-quick", child);
    await endRun("run-quick");
    expect(announceSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ARCHIVE_AFTER_MS - MINUTE_MS);
    expect(deletedKeys()).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    expect(deletedKeys()).toEqual([child]);
    expect(findRun("run-quick")).toBeUndefined();
  });

  it("never sweeps a live run that carries a stale archiveAtMs, and logs that once", async () => {
    const logSpy = vi.spyOn(runtime.defaultRuntime, "log");
    const liveChild = "agent:main:subagent:live";
    register("run-done", "agent:main:subagent:done");
    register("run-live", liveChild);
    // An ended run keeps the sweeper running.
    await endRun("run-done");

    const live = findRun("run-live");
    expect(live).toBeDefined();
    live!.archiveAtMs = Date.now() - 1;

    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
    expect(deletedKeys()).not.toContain(liveChild);
    expect(findRun("run-live")).toBeDefined();

    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
    const staleLogs = logSpy.mock.calls.filter(([line]) => String(line).includes("run-live"));
    expect(staleLogs).toHaveLength(1);
  });

  it("clears a spawn-time archiveAtMs on a restored live record and never sweeps it", async () => {
    const now = Date.now();
    const child = "agent:main:subagent:legacy";
    loadRegistryMock.mockReturnValue(
      new Map<string, SubagentRunRecord>([
        [
          "run-legacy",
          {
            runId: "run-legacy",
            childSessionKey: child,
            requesterSessionKey: MAIN_KEY,
            requesterDisplayKey: "main",
            task: "legacy live run",
            cleanup: "keep",
            spawnMode: "run",
            createdAt: now - 2 * ARCHIVE_AFTER_MS,
            startedAt: now - 2 * ARCHIVE_AFTER_MS,
            archiveAtMs: now - ARCHIVE_AFTER_MS,
          },
        ],
      ]),
    );

    mod.initSubagentRegistry();
    await flush();
    expect(findRun("run-legacy")?.archiveAtMs).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    expect(deletedKeys()).toEqual([]);
    expect(findRun("run-legacy")).toBeDefined();
  });

  it("does not give a steer/wake replacement run an archive time, even from an ended source", async () => {
    const child = "agent:main:subagent:steer";
    register("run-first", child);
    await endRun("run-first");

    expect(
      mod.replaceSubagentRunAfterSteer({ previousRunId: "run-first", nextRunId: "run-second" }),
    ).toBe(true);
    const next = findRun("run-second");
    expect(next?.endedAt).toBeUndefined();
    expect(next?.archiveAtMs).toBeUndefined();

    await vi.advanceTimersByTimeAsync(ARCHIVE_AFTER_MS + 5 * MINUTE_MS);
    expect(deletedKeys()).toEqual([]);
    expect(findRun("run-second")).toBeDefined();
  });

  it("lets a runTimeoutSeconds: 0 child run past 60 minutes: an expired wait is re-armed, not the end", async () => {
    // The gateway answers an expired wait with { status: "timeout" } and no terminal snapshot.
    agentWaitImpl = async () => ({ status: "timeout" });
    const child = "agent:main:subagent:nolimit";
    register("run-nolimit", child, { runTimeoutSeconds: 0 });
    await flush();

    await vi.advanceTimersByTimeAsync(ARCHIVE_AFTER_MS + 5 * MINUTE_MS);
    const run = findRun("run-nolimit");
    expect(run?.endedAt).toBeUndefined();
    expect(run?.outcome).toBeUndefined();
    expect(announceSpy).not.toHaveBeenCalled();
    expect(deletedKeys()).toEqual([]);

    const waits = agentWaitCalls();
    expect(waits.length).toBeGreaterThan(1);
    for (const wait of waits) {
      expect(wait.params).toMatchObject({
        runId: "run-nolimit",
        timeoutMs: timeout.NO_AGENT_TIMEOUT_MS,
      });
    }

    agentWaitImpl = pendingWait;
    await endRun("run-nolimit");
    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(findRun("run-nolimit")?.outcome).toEqual({ status: "ok" });
  });

  it("re-arms the wait of an uncapped run after a transport failure", async () => {
    let calls = 0;
    agentWaitImpl = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("gateway timeout after 2147483647ms");
      }
      return await pendingWait();
    };
    register("run-transport", "agent:main:subagent:transport", { runTimeoutSeconds: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

    expect(agentWaitCalls()).toHaveLength(2);
    expect(findRun("run-transport")?.endedAt).toBeUndefined();
  });

  it("keeps runTimeoutSeconds as the wait limit and ends the run as timed out when it expires (unchanged)", async () => {
    agentWaitImpl = async () => ({ status: "timeout" });
    register("run-capped", "agent:main:subagent:capped", { runTimeoutSeconds: 120 });
    await flush();

    expect(agentWaitCalls()[0]?.params).toMatchObject({ runId: "run-capped", timeoutMs: 120_000 });
    const run = findRun("run-capped");
    expect(typeof run?.endedAt).toBe("number");
    expect(run?.outcome).toEqual({ status: "timeout" });
    expect(announceSpy).toHaveBeenCalledTimes(1);
  });
});
