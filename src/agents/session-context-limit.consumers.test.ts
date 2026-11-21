import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryFlushContextWindowTokens } from "../auto-reply/reply/memory-flush.js";
import { persistSessionUsageUpdate } from "../auto-reply/reply/session-usage.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveHeartbeatContextWindow } from "../infra/heartbeat-compaction.js";
import { readSessionContextLimit } from "../sessions/context-limit.js";
import { buildEmbeddedExtensionFactories } from "./pi-embedded-runner/extensions.js";
import { getCompactionSafeguardRuntime } from "./pi-extensions/compaction-safeguard-runtime.js";

/**
 * docs/design/session-context-limit.md §1.2 and §1.4: every window consumer uses the same rule
 * (lowest wins, absent changes nothing), and a sub-agent of a limited chat is not limited.
 */

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function makeStore(entries: Record<string, SessionEntry>) {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-limit-consumers-"));
  const storePath = path.join(tempDir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries));
  return storePath;
}

describe("compaction safeguard budgets against the lowered window", () => {
  const model = { id: "big", contextWindow: 1_000_000 } as Model<Api>;
  const cfg = { agents: { defaults: { compaction: { mode: "safeguard" } } } } as OpenClawConfig;

  function safeguardWindow(sessionContextLimit?: number) {
    const sessionManager = {} as SessionManager;
    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "acme",
      modelId: "big",
      model,
      sessionContextLimit,
    });
    return getCompactionSafeguardRuntime(sessionManager)?.contextWindowTokens;
  }

  it("absent: the model window; below: the limit; above: the model window", () => {
    expect(safeguardWindow(undefined)).toBe(1_000_000);
    expect(safeguardWindow(128_000)).toBe(128_000);
    expect(safeguardWindow(2_000_000)).toBe(1_000_000);
  });
});

describe("memory flush and heartbeat windows", () => {
  it("memory flush window: absent unchanged, lowered by a lower limit only", () => {
    const today = resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 300_000 });
    expect(
      resolveMemoryFlushContextWindowTokens({
        agentCfgContextTokens: 300_000,
        sessionContextLimit: undefined,
      }),
    ).toBe(today);
    expect(
      resolveMemoryFlushContextWindowTokens({
        agentCfgContextTokens: 300_000,
        sessionContextLimit: 64_000,
      }),
    ).toBe(64_000);
    expect(
      resolveMemoryFlushContextWindowTokens({
        agentCfgContextTokens: 300_000,
        sessionContextLimit: 500_000,
      }),
    ).toBe(today);
  });

  it("heartbeat window: absent unchanged, lowered by a lower limit only", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 300_000 } },
    } as OpenClawConfig;
    const model = { provider: "acme", model: "big" };
    const base: SessionEntry = { sessionId: "h", updatedAt: 1 };
    const today = resolveHeartbeatContextWindow({ cfg, model, entry: base });
    expect(today).toBe(200_000);
    expect(
      resolveHeartbeatContextWindow({ cfg, model, entry: { ...base, contextLimit: 64_000 } }),
    ).toBe(64_000);
    expect(
      resolveHeartbeatContextWindow({ cfg, model, entry: { ...base, contextLimit: 250_000 } }),
    ).toBe(today);
  });
});

describe("recorded contextTokens (ARCH §1.2)", () => {
  const key = "agent:main:main";

  it("is lowered by the entry's limit when usage is persisted; unchanged without one", async () => {
    const storePath = await makeStore({
      [key]: { sessionId: "m", updatedAt: 1, contextLimit: 64_000 },
      "agent:main:other": { sessionId: "o", updatedAt: 1 },
    });
    for (const sessionKey of [key, "agent:main:other"]) {
      await persistSessionUsageUpdate({
        storePath,
        sessionKey,
        usage: { input: 10, output: 1 },
        lastCallUsage: { input: 10, output: 1 },
        modelUsed: "big",
        providerUsed: "acme",
        contextTokensUsed: 1_000_000,
      });
    }
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[key]?.contextTokens).toBe(64_000);
    expect(store[key]?.contextLimit).toBe(64_000);
    expect(store["agent:main:other"]?.contextTokens).toBe(1_000_000);
  });
});

describe("not inherited (ARCH §1.4)", () => {
  it("a sub-agent, cron or thread session of a limited chat reads no limit", async () => {
    const parent = "agent:main:whatsapp:group:alerts@g.us";
    const storePath = await makeStore({
      [parent]: { sessionId: "p", updatedAt: 1, contextLimit: 64_000 },
      "agent:main:subagent:child-1": { sessionId: "c", updatedAt: 1, spawnedBy: parent },
      "agent:main:cron:job-1": { sessionId: "j", updatedAt: 1 },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    expect(readSessionContextLimit({ cfg, sessionKey: parent })).toBe(64_000);
    expect(
      readSessionContextLimit({ cfg, sessionKey: "agent:main:subagent:child-1" }),
    ).toBeUndefined();
    expect(readSessionContextLimit({ cfg, sessionKey: "agent:main:cron:job-1" })).toBeUndefined();
    expect(readSessionContextLimit({ cfg, sessionKey: `${parent}:thread:t1` })).toBeUndefined();
  });
});
