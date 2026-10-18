import type { BrowserTab } from "./client.js";

/**
 * Per-tab bookkeeping for browsers freeclaw launches (ARCH §2.3-§2.4).
 * Tabs freeclaw did not open itself (for example the initial about:blank) have no entry and
 * count as oldest.
 */
export type ManagedTabMeta = {
  openedAt: number;
  keep: boolean;
};

export type ManagedTabRegistry = Map<string, ManagedTabMeta>;

const tabUses = new Map<string, number>();

function tabUseKey(cdpUrl: string, targetId: string): string {
  return `${cdpUrl}\u0000${targetId}`;
}

/**
 * Mark a tab as in use by an active tool call. The watchdog and maxTabs eviction never close
 * a tab that is in use. Returns a release function (idempotent).
 */
export function beginTabUse(cdpUrl: string, targetId: string): () => void {
  const key = tabUseKey(cdpUrl, targetId);
  tabUses.set(key, (tabUses.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const next = (tabUses.get(key) ?? 1) - 1;
    if (next <= 0) {
      tabUses.delete(key);
    } else {
      tabUses.set(key, next);
    }
  };
}

export function isTabInUse(cdpUrl: string, targetId: string): boolean {
  return (tabUses.get(tabUseKey(cdpUrl, targetId)) ?? 0) > 0;
}

export function resetTabUsesForTests(): void {
  tabUses.clear();
}

/**
 * Order page tabs oldest first: tabs without metadata (not opened by the tool) first in list
 * order, then tabs by the time they were opened.
 */
export function orderTabsOldestFirst<T extends Pick<BrowserTab, "targetId">>(
  tabs: T[],
  meta: ManagedTabRegistry | undefined,
): T[] {
  return tabs
    .map((tab, index) => ({ tab, index, openedAt: meta?.get(tab.targetId)?.openedAt ?? -1 }))
    .toSorted((a, b) => a.openedAt - b.openedAt || a.index - b.index)
    .map((entry) => entry.tab);
}

/**
 * Pick the page tabs to close so that at most `maxTabs` remain (ARCH §2.3): oldest first, never
 * a tab marked keep, never the protected (just-opened) tab, never a tab in use.
 */
export function selectTabsToEvict<T extends Pick<BrowserTab, "targetId">>(params: {
  pageTabs: T[];
  meta: ManagedTabRegistry | undefined;
  maxTabs: number;
  protectTargetId?: string;
  isInUse?: (targetId: string) => boolean;
}): T[] {
  const excess = params.pageTabs.length - Math.max(1, params.maxTabs);
  if (excess <= 0) {
    return [];
  }
  const candidates = orderTabsOldestFirst(params.pageTabs, params.meta).filter(
    (tab) =>
      tab.targetId !== params.protectTargetId &&
      params.meta?.get(tab.targetId)?.keep !== true &&
      !params.isInUse?.(tab.targetId),
  );
  return candidates.slice(0, excess);
}

/** Drop metadata for tabs that no longer exist. */
export function pruneTabMeta(
  meta: ManagedTabRegistry | undefined,
  liveTabs: Array<Pick<BrowserTab, "targetId">>,
): void {
  if (!meta) {
    return;
  }
  const live = new Set(liveTabs.map((tab) => tab.targetId));
  for (const targetId of meta.keys()) {
    if (!live.has(targetId)) {
      meta.delete(targetId);
    }
  }
}
