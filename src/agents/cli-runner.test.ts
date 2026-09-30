import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runCliAgent } from "./cli-runner.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";
import { NO_AGENT_TIMEOUT_MS } from "./timeout.js";

const supervisorSpawnMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

type MockRunExit = {
  reason:
    | "manual-cancel"
    | "overall-timeout"
    | "no-output-timeout"
    | "spawn-error"
    | "signal"
    | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

function createManagedRun(exit: MockRunExit, pid = 1234) {
  return {
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue(exit),
    cancel: vi.fn(),
  };
}

describe("runCliAgent with process supervisor", () => {
  beforeEach(() => {
    supervisorSpawnMock.mockReset();
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
  });

  it("runs CLI through supervisor and returns payload", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-1",
      cliSessionId: "thread-123",
    });

    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      mode?: string;
      timeoutMs?: number;
      noOutputTimeoutMs?: number;
      replaceExistingScope?: boolean;
      scopeKey?: string;
    };
    expect(input.mode).toBe("child");
    expect(input.argv?.[0]).toBe("codex");
    expect(input.timeoutMs).toBeGreaterThan(0);
    expect(input.timeoutMs).toBeLessThanOrEqual(1_000);
    expect(input.noOutputTimeoutMs).toBeGreaterThanOrEqual(1_000);
    expect(input.replaceExistingScope).toBe(true);
    expect(input.scopeKey).toContain("thread-123");
  });

  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    const aborted = await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-2",
      cliSessionId: "thread-123",
    });
    expect(aborted.meta.aborted).toBe(true);
    expect(aborted.payloads?.[0]?.isError).toBe(true);
    expect(aborted.payloads?.[0]?.text).toContain("produced no output");
  });

  it("enqueues a system event and heartbeat wake on no-output watchdog timeout for session runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    const aborted = await runCliAgent({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-2b",
      cliSessionId: "thread-123",
    });
    expect(aborted.meta.aborted).toBe(true);
    expect(aborted.payloads?.[0]?.isError).toBe(true);
    expect(aborted.payloads?.[0]?.text).toContain("produced no output");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [notice, opts] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(String(notice)).toContain("produced no output");
    expect(String(notice)).toContain("interactive input or an approval prompt");
    expect(opts).toMatchObject({ sessionKey: "agent:main:main" });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "cli:watchdog:stall",
      sessionKey: "agent:main:main",
    });
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      }),
    );

    const aborted = await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-3",
      cliSessionId: "thread-123",
    });
    expect(aborted.meta.aborted).toBe(true);
    expect(aborted.payloads?.[0]?.isError).toBe(true);
    expect(aborted.payloads?.[0]?.text).toContain(
      "CLI run exceeded configured limit of 1s and was stopped.",
    );
  });

  it("does not start a queued CLI run once the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 60_000,
      abortSignal: controller.signal,
      runId: "run-aborted",
    });

    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    expect(result.meta.aborted).toBe(true);
  });

  it("honours a caller-supplied absolute deadline that already expired while queued (A19)", async () => {
    // Callers (cron, agent CLI, follow-up) pass runDeadlineParams(), which includes the original
    // runDeadlineAtMs. Queue wait must count against that clock, not a fresh createRunDeadline(timeoutMs)
    // started at runCliAgent entry. RED until CliRunParams seeds from runDeadlineAtMs (mirror run.ts).
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 10,
        stdout: "should-not-run",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    const params = {
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 10_000,
      runLimitMs: 10_000,
      runDeadlineAtMs: Date.now() - 1_000,
      runId: "run-a19-expired-deadline",
    };
    const result = await runCliAgent(params as Parameters<typeof runCliAgent>[0]);

    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    expect(result.meta.aborted).toBe(true);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain(
      "CLI run exceeded configured limit of 10s and was stopped.",
    );
  });

  it("cancels a CLI child that is already running when the caller aborts", async () => {
    const controller = new AbortController();
    let resolveWait: ((exit: unknown) => void) | undefined;
    const cancel = vi.fn(() =>
      resolveWait?.({
        reason: "manual-cancel",
        exitCode: null,
        exitSignal: "SIGTERM",
        durationMs: 10,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockImplementationOnce(async () => ({
      runId: "run-abort-live",
      pid: 4321,
      startedAtMs: Date.now(),
      stdin: undefined,
      wait: () =>
        new Promise((resolve) => {
          resolveWait = resolve;
        }),
      cancel,
    }));

    const pending = runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 60_000,
      abortSignal: controller.signal,
      runId: "run-abort-live",
    });
    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await pending;

    expect(cancel).toHaveBeenCalledWith("manual-cancel");
    expect(result.meta.aborted).toBe(true);
  });

  it("session-expired retry draws from the same run deadline", async () => {
    supervisorSpawnMock.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 10,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 10_000,
      runId: "run-retry-deadline",
      cliSessionId: "thread-123",
    });

    const [first, second] = supervisorSpawnMock.mock.calls.map(
      (c) => (c[0] as { timeoutMs?: number }).timeoutMs ?? 0,
    );
    expect(first).toBeLessThanOrEqual(10_000);
    expect(second).toBeLessThanOrEqual(10_000 - 40);
  });

  it("spawns without a wall-clock cap and with the idle window when no run limit is set", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: NO_AGENT_TIMEOUT_MS,
      runId: "run-uncapped",
      config: { agents: { defaults: { idleTimeoutSeconds: 900 } } },
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      timeoutMs?: number;
      noOutputTimeoutMs?: number;
    };
    expect(input.timeoutMs).toBeUndefined();
    expect(input.noOutputTimeoutMs).toBe(900_000);
  });

  it("rethrows the retry failure when session-expired recovery retry also fails", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "rate limit exceeded",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:subagent:retry",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-retry-failure",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("rate limit exceeded");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to per-agent workspace when workspaceDir is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-"));
    const fallbackWorkspace = path.join(tempDir, "workspace-main");
    await fs.mkdir(fallbackWorkspace, { recursive: true });
    const cfg = {
      agents: {
        defaults: {
          workspace: fallbackWorkspace,
        },
      },
    } satisfies OpenClawConfig;

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:subagent:missing-workspace",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: undefined as unknown as string,
        config: cfg,
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-4",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { cwd?: string };
    expect(input.cwd).toBe(path.resolve(fallbackWorkspace));
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("uses backend-configured resume watchdog override", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "codex",
        reliability: {
          watchdog: {
            resume: {
              noOutputTimeoutMs: 42_000,
            },
          },
        },
      },
      timeoutMs: 120_000,
      useResume: true,
    });
    expect(timeoutMs).toBe(42_000);
  });

  it("uses the agent idle window, not a wall-clock cap, when no run limit is configured", () => {
    const backend = { command: "claude" };
    expect(
      resolveCliNoOutputTimeoutMs({
        backend,
        timeoutMs: NO_AGENT_TIMEOUT_MS,
        useResume: false,
        idleTimeoutMs: 600_000,
      }),
    ).toBe(600_000);
    // Resume runs follow the same idle window rather than the 180 s ratio cap.
    expect(
      resolveCliNoOutputTimeoutMs({
        backend,
        timeoutMs: NO_AGENT_TIMEOUT_MS,
        useResume: true,
        idleTimeoutMs: 1_200_000,
      }),
    ).toBe(1_200_000);
    expect(
      resolveCliNoOutputTimeoutMs({
        backend,
        timeoutMs: NO_AGENT_TIMEOUT_MS,
        useResume: false,
        idleTimeoutMs: 0,
      }),
    ).toBe(0);
  });

  it("keeps the ratio-of-cap window when a run limit is configured", () => {
    expect(
      resolveCliNoOutputTimeoutMs({
        backend: { command: "claude" },
        timeoutMs: 300_000,
        useResume: false,
        idleTimeoutMs: 600_000,
      }),
    ).toBe(240_000);
  });
});

describe("CLI stall/limit aborts and model fallback", () => {
  it("a CLI stall does not advance to the next fallback model", async () => {
    const { runWithModelFallback } = await import("./model-fallback.js");
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );
    const run = vi.fn(async (provider: string, model: string) =>
      runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider,
        model,
        timeoutMs: 60_000,
        runId: "run-fallback-stall",
      }),
    );

    const result = await runWithModelFallback({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "codex-cli/gpt-5.2-codex", fallbacks: ["openai/gpt-5.2"] },
          },
        },
      } as OpenClawConfig,
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.result.meta.aborted).toBe(true);
    expect(result.result.payloads?.[0]?.text).toContain("(stalled)");
  });
});
