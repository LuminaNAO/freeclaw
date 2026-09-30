import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  appendOutput,
  drainSession,
  hasLiveProcessForScope,
  listFinishedSessions,
  onProcessOutput,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";

describe("bash process registry", () => {
  function createRegistrySession(params: {
    id?: string;
    maxOutputChars: number;
    pendingMaxOutputChars: number;
    backgrounded: boolean;
  }): ProcessSession {
    return createProcessSessionFixture({
      id: params.id ?? "sess",
      command: "echo test",
      child: { pid: 123, removeAllListeners: vi.fn() } as unknown as ChildProcessWithoutNullStreams,
      maxOutputChars: params.maxOutputChars,
      pendingMaxOutputChars: params.pendingMaxOutputChars,
      backgrounded: params.backgrounded,
    });
  }

  beforeEach(() => {
    resetProcessRegistryForTests();
  });

  it("reports live foreground and background processes per scope", () => {
    const fg = createRegistrySession({
      id: "fg",
      maxOutputChars: 100,
      pendingMaxOutputChars: 100,
      backgrounded: false,
    });
    fg.scopeKey = "agent:main:main";
    const bg = createRegistrySession({
      id: "bg",
      maxOutputChars: 100,
      pendingMaxOutputChars: 100,
      backgrounded: true,
    });
    bg.scopeKey = "agent:main:other";
    addSession(fg);
    addSession(bg);

    expect(hasLiveProcessForScope("agent:main:main")).toBe(true);
    expect(hasLiveProcessForScope("agent:main:other")).toBe(true);
    expect(hasLiveProcessForScope("agent:main:none")).toBe(false);
    expect(hasLiveProcessForScope(undefined)).toBe(false);

    markExited(fg, 0, null, "completed");
    expect(hasLiveProcessForScope("agent:main:main")).toBe(false);
  });

  it("ignores processes started before the run when sinceMs is given, and reports output", () => {
    const old = createRegistrySession({
      id: "old",
      maxOutputChars: 100,
      pendingMaxOutputChars: 100,
      backgrounded: true,
    });
    old.scopeKey = "agent:main:main";
    old.startedAt = 1_000;
    addSession(old);
    expect(hasLiveProcessForScope("agent:main:main", 5_000)).toBe(false);
    expect(hasLiveProcessForScope("agent:main:main", 500)).toBe(true);

    const seen: Array<{ scopeKey: string | undefined; startedAt: number }> = [];
    const off = onProcessOutput((source) => seen.push(source));
    appendOutput(old, "stdout", "tick");
    off();
    appendOutput(old, "stdout", "tock");
    expect(seen).toEqual([{ scopeKey: "agent:main:main", startedAt: 1_000 }]);
  });

  it("captures output and truncates", () => {
    const session = createRegistrySession({
      maxOutputChars: 10,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });

    addSession(session);
    appendOutput(session, "stdout", "0123456789");
    appendOutput(session, "stdout", "abcdef");

    expect(session.aggregated).toBe("6789abcdef");
    expect(session.truncated).toBe(true);
  });

  it("caps pending output to avoid runaway polls", () => {
    const session = createRegistrySession({
      maxOutputChars: 100_000,
      pendingMaxOutputChars: 20_000,
      backgrounded: true,
    });

    addSession(session);
    const payload = `${"a".repeat(70_000)}${"b".repeat(20_000)}`;
    appendOutput(session, "stdout", payload);

    const drained = drainSession(session);
    expect(drained.stdout).toBe("b".repeat(20_000));
    expect(session.pendingStdout).toHaveLength(0);
    expect(session.pendingStdoutChars).toBe(0);
    expect(session.truncated).toBe(true);
  });

  it("respects max output cap when pending cap is larger", () => {
    const session = createRegistrySession({
      maxOutputChars: 5_000,
      pendingMaxOutputChars: 30_000,
      backgrounded: true,
    });

    addSession(session);
    appendOutput(session, "stdout", "x".repeat(10_000));

    const drained = drainSession(session);
    expect(drained.stdout.length).toBe(5_000);
    expect(session.truncated).toBe(true);
  });

  it("caps stdout and stderr independently", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 10,
      backgrounded: true,
    });

    addSession(session);
    appendOutput(session, "stdout", "a".repeat(6));
    appendOutput(session, "stdout", "b".repeat(6));
    appendOutput(session, "stderr", "c".repeat(12));

    const drained = drainSession(session);
    expect(drained.stdout).toBe("a".repeat(4) + "b".repeat(6));
    expect(drained.stderr).toBe("c".repeat(10));
    expect(session.truncated).toBe(true);
  });

  it("only persists finished sessions when backgrounded", () => {
    const session = createRegistrySession({
      maxOutputChars: 100,
      pendingMaxOutputChars: 30_000,
      backgrounded: false,
    });

    addSession(session);
    markExited(session, 0, null, "completed");
    expect(listFinishedSessions()).toHaveLength(0);

    markBackgrounded(session);
    markExited(session, 0, null, "completed");
    expect(listFinishedSessions()).toHaveLength(1);
  });
});
