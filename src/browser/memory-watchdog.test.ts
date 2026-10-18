import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_MEMORY_WATCHDOG_INTERVAL_MS,
  runBrowserMemoryWatchdogCheck,
  runBrowserMemoryWatchdogOnce,
  startBrowserMemoryWatchdog,
  type BrowserMemoryWatchdogTarget,
} from "./memory-watchdog.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";
import type { ManagedTabRegistry } from "./tab-hygiene.js";

const MiB = 1024 * 1024;

function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) },
  };
}

/** A fake browser whose RSS drops by `perTabMb` for every closed tab. */
function makeTarget(params: {
  limitMb: number;
  rssMb: number;
  perTabMb: number;
  tabs: string[];
  meta?: ManagedTabRegistry;
  inUse?: string[];
}) {
  let rssMb = params.rssMb;
  const open = [...params.tabs];
  const closeTab = vi.fn(async (targetId: string) => {
    open.splice(open.indexOf(targetId), 1);
    rssMb -= params.perTabMb;
  });
  const restart = vi.fn(async () => {});
  const target: BrowserMemoryWatchdogTarget = {
    profileName: "openclaw",
    limitMb: params.limitMb,
    measureRssBytes: async () => rssMb * MiB,
    listPageTabs: async () => open.map((targetId) => ({ targetId, url: `https://x/${targetId}` })),
    tabMeta: params.meta,
    isInUse: (targetId) => params.inUse?.includes(targetId) ?? false,
    closeTab,
    restart,
  };
  return { target, closeTab, restart, open };
}

describe("browser memory watchdog (ARCH §2.4)", () => {
  it("does nothing at or below 90 % of the cap", async () => {
    const { target, closeTab, restart } = makeTarget({
      limitMb: 1000,
      rssMb: 900,
      perTabMb: 100,
      tabs: ["a", "b"],
    });
    const result = await runBrowserMemoryWatchdogCheck(target, { settleMs: 0 });
    expect(result.action).toBe("none");
    expect(closeTab).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("above 90 % closes idle tabs oldest first, skips the active one, stops under 75 %", async () => {
    const meta: ManagedTabRegistry = new Map([
      ["t-new", { openedAt: 400, keep: false }],
      ["t-active", { openedAt: 100, keep: false }],
      ["t-mid", { openedAt: 300, keep: false }],
      ["t-old", { openedAt: 200, keep: true }],
    ]);
    const { target, closeTab, restart } = makeTarget({
      limitMb: 1000,
      rssMb: 950,
      perTabMb: 120,
      tabs: ["t-new", "t-active", "t-mid", "t-old"],
      meta,
      inUse: ["t-active"],
    });
    const { lines, logger } = makeLogger();
    const result = await runBrowserMemoryWatchdogCheck(target, { settleMs: 0, logger });

    // 950 -> 830 (t-old) -> 710 (t-mid) <= 750: stop. t-active (oldest) is skipped.
    expect(closeTab.mock.calls.map((c) => c[0])).toEqual(["t-old", "t-mid"]);
    expect(result).toMatchObject({ action: "closed-tabs", closed: ["t-old", "t-mid"] });
    expect(restart).not.toHaveBeenCalled();
    // One log line per watchdog action.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("closed idle tab t-old");
    expect(meta.has("t-old")).toBe(false);
  });

  it("restarts the browser when still above the cap after closing idle tabs", async () => {
    const { target, closeTab, restart } = makeTarget({
      limitMb: 1000,
      rssMb: 1500,
      perTabMb: 50,
      tabs: ["a", "b", "active"],
      inUse: ["active"],
    });
    const { lines, logger } = makeLogger();
    const result = await runBrowserMemoryWatchdogCheck(target, { settleMs: 0, logger });

    expect(closeTab.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    expect(closeTab).not.toHaveBeenCalledWith("active");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("restarted");
    expect(lines.at(-1)).toContain("restarting browser");
  });

  it("does not restart when tab closing brings it under the cap but not under 75 %", async () => {
    const { target, restart } = makeTarget({
      limitMb: 1000,
      rssMb: 950,
      perTabMb: 100,
      tabs: ["a", "active"],
      inUse: ["active"],
    });
    const result = await runBrowserMemoryWatchdogCheck(target, { settleMs: 0 });
    expect(result.action).toBe("closed-tabs");
    expect(restart).not.toHaveBeenCalled();
  });

  it("reports unmeasured and touches nothing when RSS cannot be read", async () => {
    const { target, closeTab, restart } = makeTarget({
      limitMb: 1000,
      rssMb: 5000,
      perTabMb: 0,
      tabs: ["a", "b"],
    });
    target.measureRssBytes = async () => null;
    const result = await runBrowserMemoryWatchdogCheck(target, { settleMs: 0 });
    expect(result.action).toBe("unmeasured");
    expect(closeTab).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});

function makeServerState(params: {
  memoryLimitMb: number;
  profiles: Array<{
    name: string;
    driver?: "openclaw" | "extension" | "existing-session";
    cdpUrl?: string;
    running: boolean;
  }>;
}): BrowserServerState {
  const profiles = new Map<string, ProfileRuntimeState>();
  for (const [index, entry] of params.profiles.entries()) {
    const cdpUrl = entry.cdpUrl ?? `http://127.0.0.1:${18800 + index}`;
    profiles.set(entry.name, {
      profile: {
        name: entry.name,
        cdpPort: 18800 + index,
        cdpUrl,
        cdpHost: new URL(cdpUrl).hostname,
        cdpIsLoopback: new URL(cdpUrl).hostname === "127.0.0.1",
        color: "#FF4500",
        driver: entry.driver ?? "openclaw",
        attachOnly: false,
      },
      running: entry.running
        ? ({ pid: 1000 + index } as unknown as ProfileRuntimeState["running"])
        : null,
      lastTargetId: null,
    });
  }
  return {
    server: null,
    port: 0,
    resolved: { memoryLimitMb: params.memoryLimitMb } as BrowserServerState["resolved"],
    profiles,
  };
}

function makeOps() {
  const calls: string[] = [];
  const forProfile = vi.fn((name: string) => ({
    listTabs: async () => [
      { targetId: `${name}-1`, title: "", url: "", type: "page" },
      { targetId: `${name}-2`, title: "", url: "", type: "page" },
    ],
    closeTab: async (targetId: string) => {
      calls.push(`close:${targetId}`);
    },
    stopRunningBrowser: async () => {
      calls.push(`stop:${name}`);
      return { stopped: true };
    },
    ensureBrowserAvailable: async () => {
      calls.push(`start:${name}`);
    },
  }));
  return { forProfile, calls };
}

describe("browser memory watchdog over server state (ARCH §2.4, §2.6)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("only acts on browsers freeclaw launched; external profiles are untouched", async () => {
    const state = makeServerState({
      memoryLimitMb: 100,
      profiles: [
        { name: "openclaw", running: true },
        { name: "user", driver: "existing-session", running: false },
        { name: "chrome-relay", driver: "extension", running: false },
        { name: "remote", cdpUrl: "https://browserless.example", running: false },
        // Something already listening on a managed port that freeclaw did not start.
        { name: "attached", running: false },
      ],
    });
    const { forProfile, calls } = makeOps();
    const measured: number[] = [];
    const results = await runBrowserMemoryWatchdogOnce(state, {
      forProfile,
      settleMs: 0,
      logger: makeLogger().logger,
      measureRssBytes: async (pid) => {
        measured.push(pid);
        return 500 * MiB;
      },
    });
    expect([...results.keys()]).toEqual(["openclaw"]);
    expect(forProfile.mock.calls.map((c) => c[0])).toEqual(["openclaw"]);
    // Only the launched browser's pid is ever measured (before and after closing a tab).
    expect(new Set(measured)).toEqual(new Set([1000]));
    expect(calls.every((c) => c.includes("openclaw"))).toBe(true);
    // Above the cap even after closing down to one page -> restart.
    expect(calls).toEqual(["close:openclaw-1", "stop:openclaw", "start:openclaw"]);
    expect(state.profiles.get("openclaw")?.memorySample?.rssBytes).toBe(500 * MiB);
  });

  it("memoryLimitMb 0 means no watchdog", async () => {
    const state = makeServerState({
      memoryLimitMb: 0,
      profiles: [{ name: "openclaw", running: true }],
    });
    const { forProfile } = makeOps();
    const measure = vi.fn(async () => 99_999 * MiB);
    const results = await runBrowserMemoryWatchdogOnce(state, {
      forProfile,
      measureRssBytes: measure,
    });
    expect(results.size).toBe(0);
    expect(measure).not.toHaveBeenCalled();
    expect(startBrowserMemoryWatchdog({ getState: () => state, deps: { forProfile } })).toBeNull();
  });

  it("runs every 60 s while the cap is on and stops cleanly", async () => {
    vi.useFakeTimers();
    const state = makeServerState({
      memoryLimitMb: 1000,
      profiles: [{ name: "openclaw", running: true }],
    });
    const { forProfile } = makeOps();
    const measure = vi.fn(async () => 10 * MiB);
    const handle = startBrowserMemoryWatchdog({
      getState: () => state,
      deps: { forProfile, measureRssBytes: measure },
    });
    expect(handle).not.toBeNull();
    expect(BROWSER_MEMORY_WATCHDOG_INTERVAL_MS).toBe(60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(measure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(measure).toHaveBeenCalledTimes(1);
    handle?.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(measure).toHaveBeenCalledTimes(1);
  });
});
