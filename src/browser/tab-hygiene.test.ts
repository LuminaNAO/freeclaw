import { afterEach, describe, expect, it } from "vitest";
import {
  beginTabUse,
  isTabInUse,
  orderTabsOldestFirst,
  pruneTabMeta,
  resetTabUsesForTests,
  selectTabsToEvict,
  type ManagedTabRegistry,
} from "./tab-hygiene.js";

const tabs = (ids: string[]) => ids.map((targetId) => ({ targetId }));

describe("tab hygiene helpers (ARCH §2.3)", () => {
  afterEach(() => resetTabUsesForTests());

  it("orders untracked tabs first, then by open time", () => {
    const meta: ManagedTabRegistry = new Map([
      ["new", { openedAt: 300, keep: false }],
      ["old", { openedAt: 100, keep: false }],
    ]);
    expect(
      orderTabsOldestFirst(tabs(["new", "blank", "old"]), meta).map((t) => t.targetId),
    ).toEqual(["blank", "old", "new"]);
  });

  it("evicts oldest non-kept tabs down to maxTabs, sparing the just-opened tab", () => {
    const meta: ManagedTabRegistry = new Map([
      ["a", { openedAt: 1, keep: true }],
      ["b", { openedAt: 2, keep: false }],
      ["c", { openedAt: 3, keep: false }],
      ["d", { openedAt: 4, keep: false }],
    ]);
    const evict = selectTabsToEvict({
      pageTabs: tabs(["a", "b", "c", "d"]),
      meta,
      maxTabs: 2,
      protectTargetId: "d",
    });
    expect(evict.map((t) => t.targetId)).toEqual(["b", "c"]);
  });

  it("evicts nothing when under the limit", () => {
    expect(selectTabsToEvict({ pageTabs: tabs(["a"]), meta: undefined, maxTabs: 8 })).toEqual([]);
  });

  it("tracks in-use tabs with an idempotent release", () => {
    const release1 = beginTabUse("cdp", "t");
    const release2 = beginTabUse("cdp", "t");
    expect(isTabInUse("cdp", "t")).toBe(true);
    release1();
    release1();
    expect(isTabInUse("cdp", "t")).toBe(true);
    release2();
    expect(isTabInUse("cdp", "t")).toBe(false);
  });

  it("prunes metadata for tabs that are gone", () => {
    const meta: ManagedTabRegistry = new Map([
      ["a", { openedAt: 1, keep: false }],
      ["b", { openedAt: 2, keep: true }],
    ]);
    pruneTabMeta(meta, tabs(["b"]));
    expect([...meta.keys()]).toEqual(["b"]);
  });
});
