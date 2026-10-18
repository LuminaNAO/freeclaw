import { browserCloseTab } from "./client.js";

export type TrackedSessionBrowserTab = {
  sessionKey: string;
  targetId: string;
  baseUrl?: string;
  profile?: string;
  trackedAt: number;
  /** Agent turn (run id) that opened the tab; closed when that turn ends unless keep. */
  runId?: string;
  /** Opened with keep: true; survives turn end (ARCH §2.3). */
  keep?: boolean;
};

type TrackedTurnBrowserTab = {
  sessionKey?: string;
  targetId: string;
  baseUrl?: string;
  profile?: string;
  /** Custom closer (for example a node browser proxy); default closes via the browser client. */
  close?: () => Promise<void>;
};

const trackedTabsBySession = new Map<string, Map<string, TrackedSessionBrowserTab>>();
const trackedTabsByRun = new Map<string, Map<string, TrackedTurnBrowserTab>>();

function normalizeSessionKey(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeTargetId(raw: string): string {
  return raw.trim();
}

function normalizeProfile(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeBaseUrl(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function toTrackedTabId(params: { targetId: string; baseUrl?: string; profile?: string }): string {
  return `${params.targetId}\u0000${params.baseUrl ?? ""}\u0000${params.profile ?? ""}`;
}

function isIgnorableCloseError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return (
    message.includes("tab not found") ||
    message.includes("target closed") ||
    message.includes("target not found") ||
    message.includes("no such target")
  );
}

function normalizeRunId(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function trackSessionBrowserTab(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  runId?: string;
  keep?: boolean;
  /** Close this tab another way at turn end (node browser proxy). Turn tracking only. */
  close?: () => Promise<void>;
}): void {
  const targetIdRaw = params.targetId?.trim();
  if (!targetIdRaw) {
    return;
  }
  const runId = normalizeRunId(params.runId);
  if (runId && params.keep !== true) {
    // ARCH §2.3: tabs opened in a turn are closed when that turn ends.
    const turnTab: TrackedTurnBrowserTab = {
      sessionKey: params.sessionKey?.trim() ? normalizeSessionKey(params.sessionKey) : undefined,
      targetId: normalizeTargetId(targetIdRaw),
      baseUrl: normalizeBaseUrl(params.baseUrl),
      profile: normalizeProfile(params.profile),
      ...(params.close ? { close: params.close } : {}),
    };
    let forRun = trackedTabsByRun.get(runId);
    if (!forRun) {
      forRun = new Map();
      trackedTabsByRun.set(runId, forRun);
    }
    forRun.set(toTrackedTabId(turnTab), turnTab);
  }
  const sessionKeyRaw = params.sessionKey?.trim();
  if (!sessionKeyRaw || params.close) {
    return;
  }
  const sessionKey = normalizeSessionKey(sessionKeyRaw);
  const targetId = normalizeTargetId(targetIdRaw);
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const profile = normalizeProfile(params.profile);
  const tracked: TrackedSessionBrowserTab = {
    sessionKey,
    targetId,
    baseUrl,
    profile,
    trackedAt: Date.now(),
    ...(runId ? { runId } : {}),
    ...(params.keep === true ? { keep: true } : {}),
  };
  const trackedId = toTrackedTabId(tracked);
  let trackedForSession = trackedTabsBySession.get(sessionKey);
  if (!trackedForSession) {
    trackedForSession = new Map();
    trackedTabsBySession.set(sessionKey, trackedForSession);
  }
  trackedForSession.set(trackedId, tracked);
}

export function untrackSessionBrowserTab(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
}): void {
  const sessionKeyRaw = params.sessionKey?.trim();
  const targetIdRaw = params.targetId?.trim();
  if (!targetIdRaw) {
    return;
  }
  const trackedId = toTrackedTabId({
    targetId: normalizeTargetId(targetIdRaw),
    baseUrl: normalizeBaseUrl(params.baseUrl),
    profile: normalizeProfile(params.profile),
  });
  for (const [runId, forRun] of trackedTabsByRun) {
    if (forRun.delete(trackedId) && forRun.size === 0) {
      trackedTabsByRun.delete(runId);
    }
  }
  if (!sessionKeyRaw) {
    return;
  }
  const sessionKey = normalizeSessionKey(sessionKeyRaw);
  const trackedForSession = trackedTabsBySession.get(sessionKey);
  if (!trackedForSession) {
    return;
  }
  trackedForSession.delete(trackedId);
  if (trackedForSession.size === 0) {
    trackedTabsBySession.delete(sessionKey);
  }
}

function takeTrackedTabsForSessionKeys(
  sessionKeys: Array<string | undefined>,
): TrackedSessionBrowserTab[] {
  const uniqueSessionKeys = new Set<string>();
  for (const key of sessionKeys) {
    if (!key?.trim()) {
      continue;
    }
    uniqueSessionKeys.add(normalizeSessionKey(key));
  }
  if (uniqueSessionKeys.size === 0) {
    return [];
  }
  const seenTrackedIds = new Set<string>();
  const tabs: TrackedSessionBrowserTab[] = [];
  for (const sessionKey of uniqueSessionKeys) {
    const trackedForSession = trackedTabsBySession.get(sessionKey);
    if (!trackedForSession || trackedForSession.size === 0) {
      continue;
    }
    trackedTabsBySession.delete(sessionKey);
    for (const tracked of trackedForSession.values()) {
      const trackedId = toTrackedTabId(tracked);
      if (seenTrackedIds.has(trackedId)) {
        continue;
      }
      seenTrackedIds.add(trackedId);
      tabs.push(tracked);
    }
  }
  return tabs;
}

type CloseTab = (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;

const defaultCloseTab: CloseTab = async (tab) => {
  await browserCloseTab(tab.baseUrl, tab.targetId, {
    profile: tab.profile,
  });
};

/**
 * ARCH §2.3: close every tab the browser tool opened during an agent turn, except the ones
 * opened with keep: true. Called when the turn ends. Returns the number of tabs closed.
 */
export async function closeTrackedBrowserTabsForRun(params: {
  runId?: string;
  closeTab?: CloseTab;
  onWarn?: (message: string) => void;
}): Promise<number> {
  const runId = normalizeRunId(params.runId);
  if (!runId) {
    return 0;
  }
  const forRun = trackedTabsByRun.get(runId);
  trackedTabsByRun.delete(runId);
  if (!forRun || forRun.size === 0) {
    return 0;
  }
  const closeTab = params.closeTab ?? defaultCloseTab;
  let closed = 0;
  for (const [trackedId, tab] of forRun) {
    if (tab.sessionKey) {
      const forSession = trackedTabsBySession.get(tab.sessionKey);
      forSession?.delete(trackedId);
      if (forSession && forSession.size === 0) {
        trackedTabsBySession.delete(tab.sessionKey);
      }
    }
    try {
      if (tab.close) {
        await tab.close();
      } else {
        await closeTab({ targetId: tab.targetId, baseUrl: tab.baseUrl, profile: tab.profile });
      }
      closed += 1;
    } catch (err) {
      if (!isIgnorableCloseError(err)) {
        params.onWarn?.(`failed to close turn browser tab ${tab.targetId}: ${String(err)}`);
      }
    }
  }
  return closed;
}

export async function closeTrackedBrowserTabsForSessions(params: {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: { targetId: string; baseUrl?: string; profile?: string }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number> {
  const tabs = takeTrackedTabsForSessionKeys(params.sessionKeys);
  if (tabs.length === 0) {
    return 0;
  }
  for (const tab of tabs) {
    const trackedId = toTrackedTabId(tab);
    for (const [runId, forRun] of trackedTabsByRun) {
      if (forRun.delete(trackedId) && forRun.size === 0) {
        trackedTabsByRun.delete(runId);
      }
    }
  }
  const closeTab = params.closeTab ?? defaultCloseTab;
  let closed = 0;
  for (const tab of tabs) {
    try {
      await closeTab({
        targetId: tab.targetId,
        baseUrl: tab.baseUrl,
        profile: tab.profile,
      });
      closed += 1;
    } catch (err) {
      if (!isIgnorableCloseError(err)) {
        params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(err)}`);
      }
    }
  }
  return closed;
}

// oxlint-disable-next-line no-underscore-dangle
export function __resetTrackedSessionBrowserTabsForTests(): void {
  trackedTabsBySession.clear();
  trackedTabsByRun.clear();
}

export function countTrackedRunBrowserTabsForTests(runId: string): number {
  return trackedTabsByRun.get(runId.trim())?.size ?? 0;
}

// oxlint-disable-next-line no-underscore-dangle
export function __countTrackedSessionBrowserTabsForTests(sessionKey?: string): number {
  if (typeof sessionKey === "string" && sessionKey.trim()) {
    return trackedTabsBySession.get(normalizeSessionKey(sessionKey))?.size ?? 0;
  }
  let count = 0;
  for (const tracked of trackedTabsBySession.values()) {
    count += tracked.size;
  }
  return count;
}
