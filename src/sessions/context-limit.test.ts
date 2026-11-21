import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  formatSessionContextLimitLines,
  resolveListedSessionContextLimit,
  resolveSessionContextWindowSummary,
} from "./context-limit-summary.js";
import {
  applyContextLimitToEntry,
  parseContextLimitValue,
  pickSessionContextLimit,
  readSessionContextLimit,
  setSessionContextLimit,
} from "./context-limit.js";

/** docs/design/session-context-limit.md §1.3 (bounds and forms), §2 (one writer), §1.1 (carry-over). */

const MODEL_CFG = {
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

describe("parseContextLimitValue (ARCH §1.3)", () => {
  it("accepts plain tokens, k and m suffixes", () => {
    expect(parseContextLimitValue("256000")).toEqual({ ok: true, value: 256_000 });
    expect(parseContextLimitValue("256k")).toEqual({ ok: true, value: 256_000 });
    expect(parseContextLimitValue("256K")).toEqual({ ok: true, value: 256_000 });
    expect(parseContextLimitValue("0.5m")).toEqual({ ok: true, value: 500_000 });
    expect(parseContextLimitValue("1m")).toEqual({ ok: true, value: 1_000_000 });
    expect(parseContextLimitValue("1.5k")).toEqual({ ok: false, error: expect.any(String) });
    expect(parseContextLimitValue("32.5k")).toEqual({ ok: true, value: 32_500 });
    expect(parseContextLimitValue(" 64k ")).toEqual({ ok: true, value: 64_000 });
    expect(parseContextLimitValue(".3m")).toEqual({ ok: true, value: 300_000 });
    expect(parseContextLimitValue(128_000)).toEqual({ ok: true, value: 128_000 });
  });

  it("clears with default (text) or null", () => {
    expect(parseContextLimitValue("default")).toEqual({ ok: true, value: null });
    expect(parseContextLimitValue("Default")).toEqual({ ok: true, value: null });
    expect(parseContextLimitValue(null)).toEqual({ ok: true, value: null });
  });

  it("accepts exactly the hard minimum and refuses below it with the minimum named", () => {
    expect(parseContextLimitValue(CONTEXT_WINDOW_HARD_MIN_TOKENS)).toEqual({
      ok: true,
      value: CONTEXT_WINDOW_HARD_MIN_TOKENS,
    });
    for (const raw of [CONTEXT_WINDOW_HARD_MIN_TOKENS - 1, "15k", "0.01m", "1", 0, -5]) {
      const parsed = parseContextLimitValue(raw);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.error).toContain(String(CONTEXT_WINDOW_HARD_MIN_TOKENS));
    }
  });

  it("refuses fractions, junk and non-finite values", () => {
    for (const raw of [
      16_000.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "",
      "abc",
      "12g",
      "1e6",
      "-64k",
      true,
      {},
    ]) {
      expect(parseContextLimitValue(raw).ok).toBe(false);
    }
  });
});

describe("applyContextLimitToEntry (ARCH §2)", () => {
  it("sets, clears and drops the recorded window when the value changes", () => {
    const entry: SessionEntry = { sessionId: "s", updatedAt: 1, contextTokens: 1_000_000 };
    expect(applyContextLimitToEntry(entry, 256_000)).toBe(true);
    expect(entry.contextLimit).toBe(256_000);
    expect(entry.contextTokens).toBeUndefined();

    entry.contextTokens = 256_000;
    expect(applyContextLimitToEntry(entry, 256_000)).toBe(false);
    expect(entry.contextTokens).toBe(256_000);

    expect(applyContextLimitToEntry(entry, null)).toBe(true);
    expect("contextLimit" in entry).toBe(false);
    expect(entry.contextTokens).toBeUndefined();
  });

  it("clearing an absent limit changes nothing", () => {
    const entry: SessionEntry = { sessionId: "s", updatedAt: 1, contextTokens: 200_000 };
    expect(applyContextLimitToEntry(entry, null)).toBe(false);
    expect(entry).toEqual({ sessionId: "s", updatedAt: 1, contextTokens: 200_000 });
  });
});

describe("pickSessionContextLimit (ARCH §1.1)", () => {
  it("carries only a valid limit", () => {
    expect(pickSessionContextLimit(undefined)).toEqual({});
    expect(pickSessionContextLimit({})).toEqual({});
    expect(pickSessionContextLimit({ contextLimit: 64_000 })).toEqual({ contextLimit: 64_000 });
    expect(pickSessionContextLimit({ contextLimit: 10 })).toEqual({});
  });
});

describe("session context limit store access", () => {
  let tempDir: string | undefined;
  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function makeStore(entries: Record<string, SessionEntry>) {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-limit-"));
    const storePath = path.join(tempDir, "sessions.json");
    await fs.writeFile(storePath, JSON.stringify(entries));
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    return { storePath, cfg };
  }

  it("reads the limit of the session's own key only (ARCH §1.4)", async () => {
    const parent = "agent:main:whatsapp:group:alerts@g.us";
    const child = "agent:main:subagent:abc";
    const { cfg } = await makeStore({
      [parent]: { sessionId: "p", updatedAt: 1, contextLimit: 64_000 },
      [child]: { sessionId: "c", updatedAt: 1, spawnedBy: parent },
    });
    expect(readSessionContextLimit({ cfg, sessionKey: parent })).toBe(64_000);
    expect(readSessionContextLimit({ cfg, sessionKey: child })).toBeUndefined();
    expect(readSessionContextLimit({ cfg, sessionKey: "agent:main:cron:job-1" })).toBeUndefined();
    expect(readSessionContextLimit({ cfg, sessionKey: undefined })).toBeUndefined();
  });

  it("ignores a stored value below the minimum (never blocks a run)", async () => {
    const key = "agent:main:main";
    const { cfg } = await makeStore({ [key]: { sessionId: "m", updatedAt: 1, contextLimit: 100 } });
    expect(readSessionContextLimit({ cfg, sessionKey: key })).toBeUndefined();
  });

  it("setSessionContextLimit writes and clears inside the store lock", async () => {
    const key = "agent:main:main";
    const { storePath } = await makeStore({
      [key]: { sessionId: "m", updatedAt: 1, contextTokens: 1_000_000, label: "keep" },
    });
    const set = await setSessionContextLimit({ storePath, sessionKey: key, value: 128_000 });
    expect(set).toMatchObject({ ok: true, changed: true });
    let stored = loadSessionStore(storePath, { skipCache: true })[key];
    expect(stored?.contextLimit).toBe(128_000);
    expect(stored?.contextTokens).toBeUndefined();
    expect(stored?.label).toBe("keep");

    const cleared = await setSessionContextLimit({ storePath, sessionKey: key, value: null });
    expect(cleared).toMatchObject({ ok: true, changed: true });
    stored = loadSessionStore(storePath, { skipCache: true })[key];
    expect(stored && "contextLimit" in stored).toBe(false);

    const missing = await setSessionContextLimit({
      storePath,
      sessionKey: "agent:main:nope",
      value: 64_000,
    });
    expect(missing.ok).toBe(false);
  });
});

describe("resolveSessionContextWindowSummary (ARCH §1.2)", () => {
  it("no limit: the model window as today", () => {
    const summary = resolveSessionContextWindowSummary({
      cfg: MODEL_CFG,
      provider: "acme",
      model: "big",
      entry: {},
    });
    expect(summary).toMatchObject({ tokens: 1_000_000, source: "model" });
    expect(
      resolveListedSessionContextLimit({ cfg: MODEL_CFG, provider: "acme", model: "big" }),
    ).toBe(undefined);
  });

  it("limit below the model window wins, and is marked", () => {
    const summary = resolveSessionContextWindowSummary({
      cfg: MODEL_CFG,
      provider: "acme",
      model: "big",
      entry: { contextLimit: 256_000 },
    });
    expect(summary).toMatchObject({ tokens: 256_000, source: "sessionContextLimit" });
    expect(formatSessionContextLimitLines(summary).join("\n")).toContain(
      "Effective window: 256k (source: session limit; model 1.0m)",
    );
  });

  it("limit above the model window or the agent cap has no effect (lowest wins)", () => {
    expect(
      resolveSessionContextWindowSummary({
        cfg: MODEL_CFG,
        provider: "acme",
        model: "big",
        entry: { contextLimit: 2_000_000 },
      }),
    ).toMatchObject({ tokens: 1_000_000, source: "model" });
    const capped = {
      ...MODEL_CFG,
      agents: { defaults: { contextTokens: 100_000 } },
    } as OpenClawConfig;
    expect(
      resolveSessionContextWindowSummary({
        cfg: capped,
        provider: "acme",
        model: "big",
        entry: { contextLimit: 256_000 },
      }),
    ).toMatchObject({ tokens: 100_000, source: "agentContextTokens" });
    expect(
      resolveListedSessionContextLimit({
        cfg: capped,
        provider: "acme",
        model: "big",
        entry: { contextLimit: 64_000 },
      }),
    ).toEqual({
      contextTokens: 64_000,
      contextLimit: 64_000,
      contextSource: "sessionContextLimit",
    });
  });
});
