import { afterEach, describe, expect, it } from "vitest";
import { classifyFailoverReason } from "./pi-embedded-helpers.js";
import {
  getProviderQuotaWindowUntil,
  isQuotaExhaustedErrorMessage,
  markProviderQuotaExhausted,
  parseQuotaResetAt,
  resetProviderQuotaWindowsForTest,
  resolveQuotaWindowUntil,
  shouldOpenQuotaWindow,
} from "./provider-quota-window.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");

describe("isQuotaExhaustedErrorMessage", () => {
  it("matches usage/quota window exhaustion", () => {
    for (const msg of [
      "You have hit your usage limit. Try again in 3 hours.",
      "429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_requests",
      "You exceeded your current quota, please check your plan and billing details.",
      "Daily usage limit reached",
      "Subscription quota limit reached; automatic quota refresh in rolling time window",
    ]) {
      expect(isQuotaExhaustedErrorMessage(msg), msg).toBe(true);
    }
  });

  it("treats long-window text as exhausted even when it also mentions a per-minute limit", () => {
    expect(
      isQuotaExhaustedErrorMessage("Daily usage limit reached. Also 3 requests per minute limit."),
    ).toBe(true);
  });

  it("does not treat per-minute throttles or unrelated errors as quota exhaustion", () => {
    for (const msg of [
      "Rate limit reached for gpt-4.1-mini in organization org_test on requests per min. Limit: 3.000000 / min.",
      "429 Too Many Requests",
      "Request timed out.",
      "overloaded_error",
      undefined,
    ]) {
      expect(isQuotaExhaustedErrorMessage(msg), String(msg)).toBe(false);
    }
  });
});

describe("parseQuotaResetAt", () => {
  it("parses retry-after seconds", () => {
    expect(parseQuotaResetAt("HTTP 429 retry-after: 120", NOW)).toBe(NOW + 120_000);
    expect(parseQuotaResetAt('{"error":"quota","retry_after": 90}', NOW)).toBe(NOW + 90_000);
  });

  it("parses relative durations", () => {
    expect(parseQuotaResetAt("Usage limit reached. Try again in 2h 30m.", NOW)).toBe(
      NOW + 2.5 * 3_600_000,
    );
    expect(parseQuotaResetAt("quota resets in 45 minutes", NOW)).toBe(NOW + 45 * 60_000);
  });

  it("parses absolute reset times", () => {
    expect(parseQuotaResetAt("usage limit; resets at 2026-01-01T05:00:00Z", NOW)).toBe(
      Date.parse("2026-01-01T05:00:00Z"),
    );
    const epochSeconds = Math.floor((NOW + 3_600_000) / 1000);
    expect(parseQuotaResetAt(`quota exhausted, reset_at: ${epochSeconds}`, NOW)).toBe(
      epochSeconds * 1000,
    );
  });

  it("parses HTTP-date Retry-After", () => {
    expect(
      parseQuotaResetAt("429 usage limit. Retry-After: Thu, 01 Jan 2026 03:00:00 GMT", NOW),
    ).toBe(Date.parse("2026-01-01T03:00:00Z"));
  });

  it("parses x-ratelimit-reset headers (epoch, ISO, and duration forms)", () => {
    const epoch = Math.floor((NOW + 7_200_000) / 1000);
    expect(parseQuotaResetAt(`quota exceeded; x-ratelimit-reset: ${epoch}`, NOW)).toBe(
      epoch * 1000,
    );
    expect(
      parseQuotaResetAt(
        "usage limit; anthropic-ratelimit-tokens-reset x-ratelimit-reset-requests: 6m0s",
        NOW,
      ),
    ).toBe(NOW + 6 * 60_000);
    expect(
      parseQuotaResetAt('quota exhausted {"x-ratelimit-reset":"2026-01-01T04:00:00Z"}', NOW),
    ).toBe(Date.parse("2026-01-01T04:00:00Z"));
  });

  it("parses Google retryDelay and 'quota will reset after' phrasing", () => {
    expect(
      parseQuotaResetAt('RESOURCE_EXHAUSTED {"@type":"RetryInfo","retryDelay":"37s"}', NOW),
    ).toBe(NOW + 37_000);
    expect(parseQuotaResetAt("Your quota will reset after 2 hours.", NOW)).toBe(
      NOW + 2 * 3_600_000,
    );
  });

  it("uses the latest hint when several are present", () => {
    expect(parseQuotaResetAt("usage limit. retry-after: 60. Resets in 3 hours.", NOW)).toBe(
      NOW + 3 * 3_600_000,
    );
  });

  it("returns undefined without a usable hint or for a reset in the past", () => {
    expect(parseQuotaResetAt("usage limit reached", NOW)).toBeUndefined();
    expect(parseQuotaResetAt("usage limit; resets at 2025-01-01T00:00:00Z", NOW)).toBeUndefined();
  });

  it("falls back to a bounded default window", () => {
    expect(resolveQuotaWindowUntil("usage limit reached", NOW)).toBe(NOW + 15 * 60_000);
    expect(resolveQuotaWindowUntil("usage limit, try again in 30 days", NOW)).toBe(
      NOW + 7 * 24 * 3_600_000,
    );
  });
});

describe("provider quota window registry", () => {
  afterEach(() => {
    resetProviderQuotaWindowsForTest();
  });

  it("records a window, keeps the later reset, and expires it", () => {
    const until = markProviderQuotaExhausted({
      provider: "OpenAI",
      message: "usage limit, try again in 2 hours",
      now: NOW,
    });
    expect(until).toBe(NOW + 2 * 3_600_000);
    markProviderQuotaExhausted({ provider: "openai", message: "usage limit", now: NOW });
    expect(getProviderQuotaWindowUntil("openai", NOW + 60_000)).toBe(NOW + 2 * 3_600_000);
    expect(getProviderQuotaWindowUntil("openai", NOW + 2 * 3_600_000 + 1)).toBeUndefined();
  });
});

describe("shouldOpenQuotaWindow (classifier/detector alignment)", () => {
  it("opens for rate_limit and for unclassified quota text", () => {
    expect(shouldOpenQuotaWindow("rate_limit", "usage limit reached")).toBe(true);
    expect(
      shouldOpenQuotaWindow(null, "Subscription quota limit reached; rolling time window"),
    ).toBe(true);
    expect(shouldOpenQuotaWindow("unknown", "quota exceeded for this project")).toBe(true);
  });

  it("classifies the audit's mismatch shapes so a window opens", () => {
    for (const msg of [
      '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}',
      "Subscription quota limit reached; automatic quota refresh in rolling time window",
      "Daily usage limit reached. Also 3 requests per minute limit.",
    ]) {
      expect(shouldOpenQuotaWindow(classifyFailoverReason(msg), msg), msg).toBe(true);
    }
  });

  it("leaves billing balance problems and auth failures to their own handling", () => {
    const balance =
      '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}';
    expect(classifyFailoverReason(balance)).toBe("billing");
    expect(shouldOpenQuotaWindow(classifyFailoverReason(balance), balance)).toBe(false);
    expect(shouldOpenQuotaWindow("auth", "usage limit reached")).toBe(false);
  });
});
