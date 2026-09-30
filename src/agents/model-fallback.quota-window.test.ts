import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { FailoverError } from "./failover-error.js";
import { runWithImageModelFallback, runWithModelFallback } from "./model-fallback.js";
import {
  getProviderQuotaWindowUntil,
  markProviderQuotaExhausted,
  resetProviderQuotaWindowsForTest,
} from "./provider-quota-window.js";
import { RunDeadlineExceededError } from "./timeout.js";

const cfg = {
  agents: {
    defaults: {
      model: {
        primary: "alpha/a1",
        fallbacks: ["beta/b1", "gamma/g1"],
      },
    },
  },
} as OpenClawConfig;

describe("runWithModelFallback quota windows", () => {
  afterEach(() => {
    resetProviderQuotaWindowsForTest();
  });

  it("records a quota-exhausted provider and skips it in a later run until the window resets", async () => {
    const quotaError = new FailoverError("You have hit your usage limit. Try again in 3 hours.", {
      reason: "rate_limit",
      provider: "beta",
      model: "b1",
      status: 429,
    });
    const firstRun = vi.fn(async (provider: string) => {
      if (provider === "alpha") {
        throw new FailoverError("overloaded", { reason: "overloaded", provider, model: "a1" });
      }
      if (provider === "beta") {
        throw quotaError;
      }
      return "ok";
    });

    const first = await runWithModelFallback({
      cfg,
      provider: "alpha",
      model: "a1",
      run: firstRun,
    });
    expect(first.result).toBe("ok");
    expect(firstRun.mock.calls.map((c) => c[0])).toEqual(["alpha", "beta", "gamma"]);
    const until = getProviderQuotaWindowUntil("beta");
    expect(until).toBeGreaterThan(Date.now() + 2.9 * 3_600_000);

    const secondRun = vi.fn(async (provider: string) => {
      if (provider === "alpha") {
        throw new FailoverError("overloaded", { reason: "overloaded", provider, model: "a1" });
      }
      return "ok";
    });
    const second = await runWithModelFallback({
      cfg,
      provider: "alpha",
      model: "a1",
      run: secondRun,
    });
    expect(second.result).toBe("ok");
    expect(secondRun.mock.calls.map((c) => c[0])).toEqual(["alpha", "gamma"]);
    expect(second.attempts.find((a) => a.provider === "beta")?.error).toContain(
      "usage limit reached",
    );
  });

  it("skips a primary whose quota window is open instead of retrying it", async () => {
    markProviderQuotaExhausted({ provider: "alpha", message: "usage limit, resets in 1 hour" });
    const run = vi.fn(async () => "ok");

    const result = await runWithModelFallback({ cfg, provider: "alpha", model: "a1", run });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("beta", "b1");
  });

  it("fails without calling any provider when every candidate is in a quota window", async () => {
    for (const provider of ["alpha", "beta", "gamma"]) {
      markProviderQuotaExhausted({ provider, message: "usage limit, resets in 2 hours" });
    }
    const run = vi.fn(async () => "ok");

    await expect(
      runWithModelFallback({ cfg, provider: "alpha", model: "a1", run }),
    ).rejects.toThrow(/usage limit reached/);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not re-probe the exhausted provider in the same run after it fails", async () => {
    const run = vi.fn(async (provider: string, _model: string) => {
      if (provider === "alpha") {
        throw new FailoverError("Usage limit reached. Try again in 1 hour.", {
          reason: "rate_limit",
          provider,
          model: "a1",
          status: 429,
        });
      }
      throw new FailoverError("overloaded", { reason: "overloaded", provider, model: "x" });
    });
    const sameProviderCfg = {
      agents: { defaults: { model: { primary: "alpha/a1", fallbacks: ["alpha/a2", "beta/b1"] } } },
    } as OpenClawConfig;

    await expect(
      runWithModelFallback({ cfg: sameProviderCfg, provider: "alpha", model: "a1", run }),
    ).rejects.toThrow();
    expect(run.mock.calls.map((c) => `${c[0]}/${c[1]}`)).toEqual(["alpha/a1", "beta/b1"]);
  });

  it("does not open a quota window for ordinary per-minute rate limits", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("Rate limit reached on requests per min. Limit: 3 / min.", {
          reason: "rate_limit",
          provider: "alpha",
          model: "a1",
          status: 429,
        }),
      )
      .mockResolvedValueOnce("ok");

    await runWithModelFallback({ cfg, provider: "alpha", model: "a1", run });

    expect(getProviderQuotaWindowUntil("alpha")).toBeUndefined();
  });
});

describe("runWithImageModelFallback quota windows", () => {
  const imageCfg = {
    agents: {
      defaults: { imageModel: { primary: "alpha/vision-1", fallbacks: ["beta/vision-2"] } },
    },
  } as OpenClawConfig;

  afterEach(() => {
    resetProviderQuotaWindowsForTest();
  });

  it("records an exhausted image provider and skips it on the next image call", async () => {
    const first = vi.fn(async (provider: string, _model: string) => {
      if (provider === "alpha") {
        throw new Error('429 RESOURCE_EXHAUSTED: quota exceeded. retryDelay: "3600s"');
      }
      return "ok";
    });
    await runWithImageModelFallback({ cfg: imageCfg, run: first });
    expect(first.mock.calls.map((c) => c[0])).toEqual(["alpha", "beta"]);
    expect(getProviderQuotaWindowUntil("alpha")).toBeGreaterThan(Date.now() + 3_500_000);

    const second = vi.fn(async (_provider: string, _model: string) => "ok");
    await runWithImageModelFallback({ cfg: imageCfg, run: second });
    expect(second.mock.calls.map((c) => c[0])).toEqual(["beta"]);
  });
});

describe("runWithModelFallback and the whole-run deadline", () => {
  it("does not start another candidate once the run deadline is spent", async () => {
    const run = vi.fn(async (provider: string, _model: string) => {
      if (provider === "alpha") {
        throw new RunDeadlineExceededError(60_000);
      }
      return "ok";
    });

    await expect(
      runWithModelFallback({ cfg, provider: "alpha", model: "a1", run }),
    ).rejects.toThrow("Run exceeded configured limit of 60s");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
