import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  deriveSessionMetaPatch,
  loadSessionStore,
  updateSessionStore,
} from "../config/sessions.js";
import { listSessionsFromStore } from "./session-utils.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

// ARCH subagent-session-names §2, §3: the name lives on the session entry.

const CHILD_KEY = "agent:main:subagent:5b6f3f0e-aaaa-4bbb-8ccc-0123456789ab";
const OTHER_CHILD_KEY = "agent:main:subagent:6c7a4a1f-bbbb-4ccc-8ddd-123456789abc";
const cfg = {
  session: { mainKey: "main" },
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;

let tmpDir = "";
let storePath = "";

async function patch(key: string, body: Record<string, unknown>) {
  return await updateSessionStore(storePath, async (store) => {
    const result = await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: key,
      patch: { key, ...body } as never,
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.entry;
  });
}

describe("subagent session names live on the session entry", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-names-store-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts label + displayName together with spawnedBy and lists the displayName", async () => {
    await patch(CHILD_KEY, {
      spawnedBy: "agent:main:main",
      label: "audit-pass",
      displayName: "Ops Room › audit-pass",
    });
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store: loadSessionStore(storePath, { skipCache: true }),
      opts: {},
    });
    const row = result.sessions.find((s) => s.key === CHILD_KEY);
    expect(row?.displayName).toBe("Ops Room › audit-pass");
    expect(row?.label).toBe("audit-pass");
    expect(row?.spawnedBy).toBe("agent:main:main");
  });

  it("allows the same task label on several spawned sessions", async () => {
    await patch(CHILD_KEY, { spawnedBy: "agent:main:main", label: "audit-pass" });
    const second = await patch(OTHER_CHILD_KEY, {
      spawnedBy: "agent:main:main",
      label: "audit-pass",
    });
    expect(second.label).toBe("audit-pass");
  });

  it("survives a run ending, later session updates and a store reload", async () => {
    await patch(CHILD_KEY, {
      spawnedBy: "agent:main:main",
      label: "audit-pass",
      displayName: "Ops Room › audit-pass",
    });
    // Later writers: spawn-depth patches, run bookkeeping, thread/group metadata.
    await patch(CHILD_KEY, { spawnDepth: 1, thinkingLevel: "low" });
    await updateSessionStore(storePath, (store) => {
      const existing = store[CHILD_KEY];
      const metaPatch = deriveSessionMetaPatch({
        ctx: {
          Provider: "signal",
          ChatType: "group",
          From: "signal:group:abc",
          GroupSubject: "Other",
        },
        sessionKey: CHILD_KEY,
        existing,
      });
      store[CHILD_KEY] = { ...existing, ...metaPatch, totalTokens: 900_000, updatedAt: Date.now() };
    });
    // "Restart": a fresh read from disk, bypassing every in-process cache.
    const reloaded = loadSessionStore(storePath, { skipCache: true })[CHILD_KEY];
    expect(reloaded?.label).toBe("audit-pass");
    expect(reloaded?.displayName).toBe("Ops Room › audit-pass");
  });

  it("can be renamed by the operator, and only then", async () => {
    await patch(CHILD_KEY, { spawnedBy: "agent:main:main", displayName: "Ops Room › audit-pass" });
    const renamed = await patch(CHILD_KEY, { displayName: "Release audit" });
    expect(renamed.displayName).toBe("Release audit");
    const cleared = await patch(CHILD_KEY, { displayName: null });
    expect(cleared.displayName).toBeUndefined();
  });

  it("rejects an empty displayName", async () => {
    await expect(patch(CHILD_KEY, { displayName: "   " })).rejects.toThrow(/displayName/);
  });
});
