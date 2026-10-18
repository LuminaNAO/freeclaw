import { createSubsystemLogger } from "../logging/subsystem.js";
import { bytesToMb, measureBrowserTreeRssBytes } from "./memory-cap.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { BrowserServerState, BrowserTab } from "./server-context.types.js";
import { isTabInUse, orderTabsOldestFirst, type ManagedTabRegistry } from "./tab-hygiene.js";

const log = createSubsystemLogger("browser").child("memory-watchdog");

/** ARCH §2.4: check every 60 s. */
export const BROWSER_MEMORY_WATCHDOG_INTERVAL_MS = 60_000;
/** Start closing idle tabs above this fraction of the cap. */
export const BROWSER_MEMORY_HIGH_WATER = 0.9;
/** Stop closing tabs once under this fraction of the cap. */
export const BROWSER_MEMORY_LOW_WATER = 0.75;
/** Time for a closed tab's renderer to exit before RSS is measured again. */
const DEFAULT_SETTLE_MS = 1_000;

export type BrowserMemoryWatchdogLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** One browser freeclaw launched, as seen by the watchdog. */
export type BrowserMemoryWatchdogTarget = {
  profileName: string;
  limitMb: number;
  measureRssBytes: () => Promise<number | null>;
  listPageTabs: () => Promise<Array<Pick<BrowserTab, "targetId" | "url">>>;
  tabMeta?: ManagedTabRegistry;
  isInUse: (targetId: string) => boolean;
  closeTab: (targetId: string) => Promise<void>;
  /** Restart the browser; the profile (cookies, logins) stays on disk. */
  restart: () => Promise<void>;
};

export type BrowserMemoryWatchdogResult = {
  action: "none" | "closed-tabs" | "restarted" | "unmeasured";
  rssBytes: number | null;
  closed: string[];
};

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * ARCH §2.4 for one browser: above 90 % of the cap, close idle tabs oldest first (never one in use
 * by an active tool call) until under 75 %; if still above the cap after that, restart it.
 * Logs one line per action.
 */
export async function runBrowserMemoryWatchdogCheck(
  target: BrowserMemoryWatchdogTarget,
  opts?: { logger?: BrowserMemoryWatchdogLogger; settleMs?: number },
): Promise<BrowserMemoryWatchdogResult> {
  const logger = opts?.logger ?? log;
  const settleMs = opts?.settleMs ?? DEFAULT_SETTLE_MS;
  const capBytes = target.limitMb * 1024 * 1024;
  if (!(capBytes > 0)) {
    return { action: "none", rssBytes: null, closed: [] };
  }
  let rss = await target.measureRssBytes();
  if (rss === null) {
    return { action: "unmeasured", rssBytes: null, closed: [] };
  }
  if (rss <= capBytes * BROWSER_MEMORY_HIGH_WATER) {
    return { action: "none", rssBytes: rss, closed: [] };
  }

  const closed: string[] = [];
  const pageTabs = await target.listPageTabs().catch(() => []);
  const candidates = orderTabsOldestFirst(pageTabs, target.tabMeta).filter(
    (tab) => !target.isInUse(tab.targetId),
  );
  let remainingPages = pageTabs.length;
  for (const tab of candidates) {
    if (rss <= capBytes * BROWSER_MEMORY_LOW_WATER) {
      break;
    }
    // Keep one page open: closing the last window can exit the browser outright.
    if (remainingPages <= 1) {
      break;
    }
    if (target.isInUse(tab.targetId)) {
      continue;
    }
    try {
      await target.closeTab(tab.targetId);
    } catch (err) {
      logger.warn(
        `browser memory watchdog: profile "${target.profileName}" failed to close tab ${tab.targetId}: ${String(err)}`,
      );
      continue;
    }
    target.tabMeta?.delete(tab.targetId);
    closed.push(tab.targetId);
    remainingPages -= 1;
    const before = rss;
    await sleep(settleMs);
    rss = (await target.measureRssBytes()) ?? rss;
    logger.warn(
      `browser memory watchdog: profile "${target.profileName}" rss ${bytesToMb(before)} MiB > ${Math.round(BROWSER_MEMORY_HIGH_WATER * 100)}% of ${target.limitMb} MiB cap; closed idle tab ${tab.targetId}${tab.url ? ` (${tab.url})` : ""}, rss now ${bytesToMb(rss)} MiB`,
    );
  }

  if (rss > capBytes) {
    logger.warn(
      `browser memory watchdog: profile "${target.profileName}" rss ${bytesToMb(rss)} MiB still above ${target.limitMb} MiB cap after closing ${closed.length} tab(s); restarting browser (profile kept on disk)`,
    );
    try {
      await target.restart();
    } catch (err) {
      logger.warn(
        `browser memory watchdog: profile "${target.profileName}" restart failed: ${String(err)}`,
      );
    }
    return { action: "restarted", rssBytes: rss, closed };
  }
  return { action: closed.length > 0 ? "closed-tabs" : "none", rssBytes: rss, closed };
}

export type BrowserMemoryWatchdogDeps = {
  measureRssBytes?: (pid: number) => Promise<number | null>;
  logger?: BrowserMemoryWatchdogLogger;
  settleMs?: number;
  /** Profile operations (listTabs/closeTab/stop/start) for a profile name. */
  forProfile: (name: string) => {
    listTabs: () => Promise<BrowserTab[]>;
    closeTab: (targetId: string) => Promise<void>;
    stopRunningBrowser: () => Promise<{ stopped: boolean }>;
    ensureBrowserAvailable: () => Promise<void>;
  };
};

/**
 * Run the watchdog once over every browser freeclaw launched (ARCH §2.4, §2.6). Externally
 * attached browsers (existing-session, extension relay, remote CDP, or a browser on the port that
 * freeclaw did not start) have no `running` handle and are never touched.
 */
export async function runBrowserMemoryWatchdogOnce(
  state: BrowserServerState,
  deps: BrowserMemoryWatchdogDeps,
): Promise<Map<string, BrowserMemoryWatchdogResult>> {
  const results = new Map<string, BrowserMemoryWatchdogResult>();
  const limitMb = state.resolved.memoryLimitMb;
  if (!(limitMb > 0)) {
    return results;
  }
  const measure = deps.measureRssBytes ?? ((pid: number) => measureBrowserTreeRssBytes(pid));
  for (const [name, profileState] of state.profiles) {
    const running = profileState.running;
    if (!running || getBrowserProfileCapabilities(profileState.profile).mode !== "local-managed") {
      continue;
    }
    const ops = deps.forProfile(name);
    const cdpUrl = profileState.profile.cdpUrl;
    const result = await runBrowserMemoryWatchdogCheck(
      {
        profileName: name,
        limitMb,
        measureRssBytes: () => measure(running.pid),
        listPageTabs: async () =>
          (await ops.listTabs()).filter((tab) => (tab.type ?? "page") === "page"),
        tabMeta: profileState.tabMeta,
        isInUse: (targetId) => isTabInUse(cdpUrl, targetId),
        closeTab: (targetId) => ops.closeTab(targetId),
        restart: async () => {
          await ops.stopRunningBrowser();
          profileState.tabMeta?.clear();
          profileState.lastTargetId = null;
          await ops.ensureBrowserAvailable();
        },
      },
      { logger: deps.logger, settleMs: deps.settleMs },
    );
    profileState.memorySample = { rssBytes: result.rssBytes, sampledAt: Date.now() };
    results.set(name, result);
  }
  return results;
}

export type BrowserMemoryWatchdogHandle = { stop: () => void };

/** Start the periodic watchdog. No-op (returns null) when `browser.memoryLimitMb` is 0. */
export function startBrowserMemoryWatchdog(params: {
  getState: () => BrowserServerState | null;
  deps: BrowserMemoryWatchdogDeps;
  intervalMs?: number;
}): BrowserMemoryWatchdogHandle | null {
  const initial = params.getState();
  if (!initial || !(initial.resolved.memoryLimitMb > 0)) {
    return null;
  }
  let inFlight = false;
  const timer = setInterval(() => {
    const state = params.getState();
    if (!state || inFlight) {
      return;
    }
    inFlight = true;
    void runBrowserMemoryWatchdogOnce(state, params.deps)
      .catch((err) => {
        (params.deps.logger ?? log).warn(`browser memory watchdog failed: ${String(err)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  }, params.intervalMs ?? BROWSER_MEMORY_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
