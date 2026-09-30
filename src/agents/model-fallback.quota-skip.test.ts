import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  getProviderQuotaWindowUntil,
  markProviderQuotaExhausted,
  resetProviderQuotaWindowsForTest,
} from "./provider-quota-window.js";

/**
 * The reported incident: after the whole-run cap killed a healthy run, fallback went to a
 * provider whose quota window was already exhausted. A provider inside its quota window must be
 * skipped for the remainder of that window — including its *other* models, since the quota is
 * per provider account, not per model.
 *
 * These cover the gap the provider-quota-window tests do not: the quota window taking precedence
 * over a *healthy-looking* auth profile. That is exactly the incident shape — the profile had no
 * cooldown and the provider looked usable, so fallback called it and burned a request.
 *
 * Note this is deliberately distinct from `usageStats.cooldownUntil`, which is the older
 * per-profile cooldown; that path still probes sibling models because ordinary rate limits are
 * often model-scoped.
 */

const makeCfg = (provider: string, fallbacks: string[]): OpenClawConfig =>
  ({
    agents: { defaults: { model: { primary: `${provider}/m1`, fallbacks } } },
  }) as unknown as OpenClawConfig;

async function withTempAuthStore<T>(store: AuthProfileStore, run: (dir: string) => Promise<T>) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runcap-quota-"));
  saveAuthProfileStore(store, tempDir);
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function makeHealthyStore(provider: string): AuthProfileStore {
  const profiles: AuthProfileStore["profiles"] = {
    [`${provider}:default`]: { type: "api_key", provider, key: "test-key" },
    "fallback:default": { type: "api_key", provider: "fallback", key: "test-key" },
  };
  return { version: AUTH_STORE_VERSION, profiles };
}

describe("runcap: fallback skips a provider inside its quota window", () => {
  afterEach(() => {
    resetProviderQuotaWindowsForTest();
  });

  it("skips an exhausted provider even when its auth profile looks healthy", async () => {
    const provider = `quota-healthy-${crypto.randomUUID()}`;
    const cfg = makeCfg(provider, ["fallback/ok-model"]);
    const store = makeHealthyStore(provider);

    // No cooldown, no failure counts: nothing else in the store would skip this provider.
    expect(store.usageStats).toBeUndefined();
    markProviderQuotaExhausted({ provider, message: "usage limit reached, resets in 2 hours" });

    const run = vi.fn().mockResolvedValue("ok");
    const result = await withTempAuthStore(store, (agentDir) =>
      runWithModelFallback({ cfg, provider, model: "m1", agentDir, run }),
    );

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("fallback");
    expect(result.attempts.find((attempt) => attempt.provider === provider)?.error).toContain(
      "usage limit reached",
    );
  });

  it("does not re-probe the exhausted provider's other models in the same run", async () => {
    // Quota is per provider account: m2/m3 must not be tried just because m1 is not.
    const provider = `quota-siblings-${crypto.randomUUID()}`;
    const cfg = makeCfg(provider, [`${provider}/m2`, `${provider}/m3`, "fallback/ok-model"]);
    const store = makeHealthyStore(provider);
    markProviderQuotaExhausted({ provider, message: "usage limit reached, resets in 2 hours" });

    const run = vi.fn().mockImplementation(async (providerId: string) => {
      if (providerId === "fallback") {
        return "ok";
      }
      throw new Error(`unexpected provider attempted: ${providerId}`);
    });

    const result = await withTempAuthStore(store, (agentDir) =>
      runWithModelFallback({ cfg, provider, model: "m1", agentDir, run }),
    );

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.map((call) => call[0])).toEqual(["fallback"]);
    // Each skipped sibling model is recorded as a quota skip, not an unexpected call.
    const skipped = result.attempts.filter((attempt) => attempt.provider === provider);
    expect(skipped).toHaveLength(3);
    expect(skipped.every((attempt) => attempt.reason === "rate_limit")).toBe(true);
  });

  it("does not skip once the quota window has elapsed", () => {
    // Guards against the skip being permanent: once `now` passes the reset the provider is
    // usable again. Queried with an explicit `now` so the test is deterministic (no sleeps).
    const provider = `quota-expired-${crypto.randomUUID()}`;
    const now = Date.now();
    const until = markProviderQuotaExhausted({
      provider,
      message: "usage limit reached, resets in 2 hours",
      now,
    });

    expect(getProviderQuotaWindowUntil(provider, now)).toBe(until);
    expect(getProviderQuotaWindowUntil(provider, until - 1)).toBe(until);
    // Window has now elapsed -> no longer skipped.
    expect(getProviderQuotaWindowUntil(provider, until)).toBeUndefined();
    expect(getProviderQuotaWindowUntil(provider, until + 60_000)).toBeUndefined();
  });
});
