import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "./context-window-guard.js";
import {
  applySessionContextLimit,
  applySessionContextLimitToTokens,
  normalizeSessionContextLimit,
} from "./session-context-limit.js";

/** docs/design/session-context-limit.md §1.2: the limit only lowers; absent changes nothing. */

const base = {
  cfg: undefined,
  provider: "acme",
  modelId: "big",
  modelContextWindow: 1_000_000,
  defaultTokens: 200_000,
};

describe("resolveContextWindowInfo with a session context limit", () => {
  it("absent or invalid: identical to today's resolution", () => {
    const today = resolveContextWindowInfo(base);
    for (const sessionContextLimit of [undefined, 0, -1, 100, 15_999, 16_000.5, Number.NaN]) {
      expect(resolveContextWindowInfo({ ...base, sessionContextLimit })).toEqual(today);
    }
    const cfg = { agents: { defaults: { contextTokens: 300_000 } } } as OpenClawConfig;
    expect(resolveContextWindowInfo({ ...base, cfg, sessionContextLimit: undefined })).toEqual(
      resolveContextWindowInfo({ ...base, cfg }),
    );
  });

  it("below the model window: lowers it and names the source", () => {
    expect(resolveContextWindowInfo({ ...base, sessionContextLimit: 256_000 })).toEqual({
      tokens: 256_000,
      source: "sessionContextLimit",
    });
  });

  it("above the model window: no effect", () => {
    expect(resolveContextWindowInfo({ ...base, sessionContextLimit: 2_000_000 })).toEqual({
      tokens: 1_000_000,
      source: "model",
    });
    expect(resolveContextWindowInfo({ ...base, sessionContextLimit: 1_000_000 })).toEqual({
      tokens: 1_000_000,
      source: "model",
    });
  });

  it("above agents.defaults.contextTokens: no effect; below it: wins", () => {
    const cfg = { agents: { defaults: { contextTokens: 300_000 } } } as OpenClawConfig;
    expect(resolveContextWindowInfo({ ...base, cfg, sessionContextLimit: 400_000 })).toEqual({
      tokens: 300_000,
      source: "agentContextTokens",
    });
    expect(resolveContextWindowInfo({ ...base, cfg, sessionContextLimit: 128_000 })).toEqual({
      tokens: 128_000,
      source: "sessionContextLimit",
    });
  });

  it("also lowers a models-config and a default window, never raises", () => {
    const cfg = {
      models: { providers: { acme: { models: [{ id: "big", contextWindow: 64_000 }] } } },
    } as unknown as OpenClawConfig;
    expect(resolveContextWindowInfo({ ...base, cfg, sessionContextLimit: 500_000 })).toEqual({
      tokens: 64_000,
      source: "modelsConfig",
    });
    expect(
      resolveContextWindowInfo({
        ...base,
        modelContextWindow: undefined,
        sessionContextLimit: 50_000,
      }),
    ).toEqual({ tokens: 50_000, source: "sessionContextLimit" });
  });

  it("a valid limit can never trip the hard-minimum guard", () => {
    const info = resolveContextWindowInfo({
      ...base,
      sessionContextLimit: CONTEXT_WINDOW_HARD_MIN_TOKENS,
    });
    expect(evaluateContextWindowGuard({ info }).shouldBlock).toBe(false);
  });
});

describe("session limit helpers", () => {
  it("normalize accepts integers at or above the hard minimum only", () => {
    expect(normalizeSessionContextLimit(CONTEXT_WINDOW_HARD_MIN_TOKENS)).toBe(
      CONTEXT_WINDOW_HARD_MIN_TOKENS,
    );
    expect(normalizeSessionContextLimit(CONTEXT_WINDOW_HARD_MIN_TOKENS - 1)).toBeUndefined();
    expect(normalizeSessionContextLimit("64000")).toBeUndefined();
    expect(normalizeSessionContextLimit(undefined)).toBeUndefined();
  });

  it("apply returns the same object when the limit does not lower", () => {
    const info = { tokens: 200_000, source: "model" as const };
    expect(applySessionContextLimit(info, undefined)).toBe(info);
    expect(applySessionContextLimit(info, 300_000)).toBe(info);
    expect(applySessionContextLimit(info, 200_000)).toBe(info);
  });

  it("number form: lowest wins, absent is a no-op, non-numbers pass through", () => {
    expect(applySessionContextLimitToTokens(200_000, undefined)).toBe(200_000);
    expect(applySessionContextLimitToTokens(200_000, 64_000)).toBe(64_000);
    expect(applySessionContextLimitToTokens(200_000, 500_000)).toBe(200_000);
    expect(applySessionContextLimitToTokens(undefined, 64_000)).toBeUndefined();
    expect(applySessionContextLimitToTokens(null, 64_000)).toBeNull();
  });
});
