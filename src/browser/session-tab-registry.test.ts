import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countTrackedRunBrowserTabsForTests,
  __countTrackedSessionBrowserTabsForTests,
  __resetTrackedSessionBrowserTabsForTests,
  closeTrackedBrowserTabsForRun,
  closeTrackedBrowserTabsForSessions,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";

describe("session tab registry", () => {
  beforeEach(() => {
    __resetTrackedSessionBrowserTabsForTests();
  });

  afterEach(() => {
    __resetTrackedSessionBrowserTabsForTests();
  });

  it("tracks and closes tabs for normalized session keys", async () => {
    trackSessionBrowserTab({
      sessionKey: "Agent:Main:Main",
      targetId: "tab-a",
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-b",
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
    });
    expect(__countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(2);

    const closeTab = vi.fn(async () => {});
    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });

    expect(closed).toBe(2);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeTab).toHaveBeenNthCalledWith(1, {
      targetId: "tab-a",
      baseUrl: "http://127.0.0.1:9222",
      profile: "openclaw",
    });
    expect(closeTab).toHaveBeenNthCalledWith(2, {
      targetId: "tab-b",
      baseUrl: "http://127.0.0.1:9222",
      profile: "openclaw",
    });
    expect(__countTrackedSessionBrowserTabsForTests()).toBe(0);
  });

  it("untracks specific tabs", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-b",
    });
    untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });

    const closeTab = vi.fn(async () => {});
    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-b",
      baseUrl: undefined,
      profile: undefined,
    });
  });

  it("deduplicates tabs and ignores expected close errors", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "main",
      targetId: "tab-b",
    });
    const warnings: string[] = [];
    const closeTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("target not found"))
      .mockRejectedValueOnce(new Error("network down"));

    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main", "main"],
      closeTab,
      onWarn: (message) => warnings.push(message),
    });

    expect(closed).toBe(0);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([expect.stringContaining("network down")]);
    expect(__countTrackedSessionBrowserTabsForTests()).toBe(0);
  });

  describe("turn-end cleanup (ARCH §2.3)", () => {
    it("closes tabs opened in a turn when the turn ends; keep: true survives", async () => {
      trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "t1", runId: "run-1" });
      trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "t2", runId: "run-1" });
      trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "kept",
        runId: "run-1",
        keep: true,
      });
      trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "other", runId: "run-2" });
      expect(countTrackedRunBrowserTabsForTests("run-1")).toBe(2);

      const closeTab = vi.fn(async () => {});
      const closed = await closeTrackedBrowserTabsForRun({ runId: "run-1", closeTab });

      expect(closed).toBe(2);
      expect(closeTab.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
        { targetId: "t1", baseUrl: undefined, profile: undefined },
        { targetId: "t2", baseUrl: undefined, profile: undefined },
      ]);
      expect(countTrackedRunBrowserTabsForTests("run-1")).toBe(0);
      // The kept tab and the other turn's tab are still tracked for the session.
      expect(__countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(2);
      expect(countTrackedRunBrowserTabsForTests("run-2")).toBe(1);
    });

    it("does not close tabs the agent already closed", async () => {
      trackSessionBrowserTab({ sessionKey: "s", targetId: "t1", runId: "run-1" });
      untrackSessionBrowserTab({ sessionKey: "s", targetId: "t1" });
      const closeTab = vi.fn(async () => {});
      expect(await closeTrackedBrowserTabsForRun({ runId: "run-1", closeTab })).toBe(0);
      expect(closeTab).not.toHaveBeenCalled();
    });

    it("tracks turn tabs without a session key and is a no-op without a run id", async () => {
      trackSessionBrowserTab({ targetId: "t1", runId: "run-x" });
      const closeTab = vi.fn(async () => {});
      expect(await closeTrackedBrowserTabsForRun({ runId: undefined, closeTab })).toBe(0);
      expect(await closeTrackedBrowserTabsForRun({ runId: "run-x", closeTab })).toBe(1);
    });

    it("ignores already-gone tabs and warns on other close errors", async () => {
      trackSessionBrowserTab({ targetId: "gone", runId: "run-1" });
      trackSessionBrowserTab({ targetId: "broken", runId: "run-1" });
      const warnings: string[] = [];
      const closeTab = vi
        .fn()
        .mockRejectedValueOnce(new Error("tab not found"))
        .mockRejectedValueOnce(new Error("network down"));
      const closed = await closeTrackedBrowserTabsForRun({
        runId: "run-1",
        closeTab,
        onWarn: (message) => warnings.push(message),
      });
      expect(closed).toBe(0);
      expect(warnings).toEqual([expect.stringContaining("network down")]);
    });

    it("session reset also forgets the turn's tabs so they are not closed twice", async () => {
      trackSessionBrowserTab({ sessionKey: "s", targetId: "t1", runId: "run-1" });
      const closeTab = vi.fn(async () => {});
      await closeTrackedBrowserTabsForSessions({ sessionKeys: ["s"], closeTab });
      expect(await closeTrackedBrowserTabsForRun({ runId: "run-1", closeTab })).toBe(0);
      expect(closeTab).toHaveBeenCalledTimes(1);
    });
  });
});
