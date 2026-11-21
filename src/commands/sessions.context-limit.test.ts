import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { listSessionsFromStore } from "../gateway/session-utils.js";
import {
  makeRuntime,
  mockSessionsConfig,
  runSessionsJson,
  writeStore,
} from "./sessions.test-helpers.js";

/**
 * docs/design/session-context-limit.md §4: session listings show the effective window and its
 * source when a chat has a limit; rows without one are unchanged.
 * Config here caps agents.defaults.contextTokens at 32k (see sessions.test-helpers).
 */

process.env.FORCE_COLOR = "0";
mockSessionsConfig();

import { sessionsCommand } from "./sessions.js";

const stores: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    fs.rmSync(store, { force: true });
  }
});

function storeWith(entries: Record<string, Partial<SessionEntry>>) {
  const store = writeStore(entries);
  stores.push(store);
  return store;
}

describe("openclaw sessions with a context limit", () => {
  it("table: the limited row shows the lower window and a ctx-limit flag; others unchanged", async () => {
    const store = storeWith({
      "discord:group:limited": {
        sessionId: "a",
        updatedAt: Date.now(),
        totalTokens: 8_000,
        totalTokensFresh: true,
        contextLimit: 16_000,
      },
      "discord:group:plain": {
        sessionId: "b",
        updatedAt: Date.now() - 1000,
        totalTokens: 8_000,
        totalTokensFresh: true,
      },
      "discord:group:above-cap": {
        sessionId: "c",
        updatedAt: Date.now() - 2000,
        totalTokens: 8_000,
        totalTokensFresh: true,
        contextLimit: 64_000,
      },
    });
    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);
    const limited = logs.find((line) => line.includes("discord:group:limited")) ?? "";
    const plain = logs.find((line) => line.includes("discord:group:plain")) ?? "";
    const aboveCap = logs.find((line) => line.includes("discord:group:above-cap")) ?? "";
    expect(limited).toContain("8.0k/16k (50%)");
    expect(limited).toContain("ctx-limit:16k");
    expect(plain).toContain("8.0k/32k (25%)");
    expect(plain).not.toContain("ctx-limit");
    // Lowest wins: the 32k agent cap is below the 64k limit.
    expect(aboveCap).toContain("8.0k/32k (25%)");
    expect(aboveCap).toContain("ctx-limit:64k");
  });

  it("json: effective contextTokens and contextSource for limited rows only", async () => {
    const store = storeWith({
      limited: { sessionId: "a", updatedAt: Date.now(), contextLimit: 16_000 },
      plain: { sessionId: "b", updatedAt: Date.now() - 1000 },
    });
    const payload = await runSessionsJson<{
      sessions: Array<{
        key: string;
        contextTokens: number | null;
        contextLimit?: number;
        contextSource?: string;
      }>;
    }>(sessionsCommand, store);
    const limited = payload.sessions.find((row) => row.key === "limited");
    const plain = payload.sessions.find((row) => row.key === "plain");
    expect(limited).toMatchObject({
      contextTokens: 16_000,
      contextLimit: 16_000,
      contextSource: "sessionContextLimit",
    });
    expect(plain?.contextTokens).toBe(32_000);
    expect(plain && "contextSource" in plain).toBe(false);
    expect(plain && "contextLimit" in plain).toBe(false);
  });
});

describe("gateway sessions.list rows with a context limit", () => {
  const cfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
    models: {
      providers: {
        acme: {
          baseUrl: "http://localhost",
          apiKey: "x",
          models: [{ id: "big", contextWindow: 1_000_000 }],
        },
      },
    },
  } as unknown as OpenClawConfig;

  it("limited rows carry the effective window, limit and source; others are as before", () => {
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:limited": {
          sessionId: "a",
          updatedAt: Date.now(),
          modelProvider: "acme",
          model: "big",
          contextTokens: 1_000_000,
          contextLimit: 256_000,
        },
        "agent:main:plain": {
          sessionId: "b",
          updatedAt: Date.now() - 1000,
          modelProvider: "acme",
          model: "big",
          contextTokens: 1_000_000,
        },
      },
      opts: {},
    });
    const limited = result.sessions.find((row) => row.key === "agent:main:limited");
    const plain = result.sessions.find((row) => row.key === "agent:main:plain");
    expect(limited).toMatchObject({
      contextTokens: 256_000,
      contextLimit: 256_000,
      contextSource: "sessionContextLimit",
    });
    expect(plain?.contextTokens).toBe(1_000_000);
    expect(plain && "contextLimit" in plain).toBe(false);
    expect(plain && "contextSource" in plain).toBe(false);
  });
});
