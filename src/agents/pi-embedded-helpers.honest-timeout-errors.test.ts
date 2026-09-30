import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { formatAssistantErrorText } from "./pi-embedded-helpers.js";
import { isTimeoutErrorMessage } from "./pi-embedded-helpers/failover-matches.js";
import {
  formatRunLimitMessage,
  formatStallMessage,
} from "./pi-embedded-runner/run/stall-watchdog.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import {
  assertRunDeadline,
  createRunDeadline,
  NO_AGENT_TIMEOUT_MS,
  RunDeadlineExceededError,
} from "./timeout.js";

/**
 * The run-limit and stall aborts are OUR aborts: no provider request timed out, so the
 * user must never be told one did. These assertions drive the copy build actually emits
 * (formatRunLimitMessage / formatStallMessage) through the formatter that reaches the user,
 * so they cannot drift from the real strings.
 *
 * Regression this pins: ERROR_PATTERNS.timeout matches the bare substring "timeout", so any
 * abort copy containing a config key name like `timeoutSeconds` gets rewritten by
 * formatAssistantErrorText into the generic "LLM request timed out.".
 */
const GENERIC_LLM_TIMEOUT = "LLM request timed out.";

const RUN_LIMIT_MESSAGE = formatRunLimitMessage(600_000);
const STALL_MESSAGE = formatStallMessage(600_000);

const makeAssistantError = (errorMessage: string): AssistantMessage =>
  makeAssistantMessageFixture({
    errorMessage,
    content: [{ type: "text", text: errorMessage }],
  });

const format = (errorMessage: string) =>
  formatAssistantErrorText(makeAssistantError(errorMessage)) ?? "";

describe("runcap: honest timeout errors (our aborts are not provider timeouts)", () => {
  it("emits run-limit and stall copy that mentions the limit, not a provider timeout", () => {
    // Guards the invariant the formatter depends on: neither string may contain "timeout".
    expect(RUN_LIMIT_MESSAGE.toLowerCase()).not.toContain("timeout");
    expect(STALL_MESSAGE.toLowerCase()).not.toContain("timed out");
  });

  it("does not report a run-limit abort as an LLM request timeout", () => {
    const text = format(RUN_LIMIT_MESSAGE);
    expect(text).not.toBe(GENERIC_LLM_TIMEOUT);
    expect(text.toLowerCase()).not.toContain("llm request timed out");
    expect(text).toBe(RUN_LIMIT_MESSAGE);
  });

  it("does not report a stall abort as an LLM request timeout", () => {
    const text = format(STALL_MESSAGE);
    expect(text).not.toBe(GENERIC_LLM_TIMEOUT);
    expect(text.toLowerCase()).not.toContain("llm request timed out");
    expect(text).toBe(STALL_MESSAGE);
  });

  it("keeps the three cases distinguishable from each other", () => {
    const runLimit = format(RUN_LIMIT_MESSAGE).toLowerCase();
    const stalled = format(STALL_MESSAGE).toLowerCase();
    const providerTimeout = format("upstream request timed out after 30000ms").toLowerCase();

    expect(runLimit).toMatch(/exceed/);
    expect(runLimit).toMatch(/limit/);

    expect(stalled).toMatch(/progress|stall|idle/);

    expect(providerTimeout).toContain("timed out");
    // A configured-limit breach and a stall are different failures with different fixes.
    expect(runLimit).not.toBe(stalled);
  });

  it("renders the configured limit and idle window in seconds", () => {
    expect(formatRunLimitMessage(120_000)).toContain("120s");
    expect(formatStallMessage(900_000)).toContain("900s");
  });

  it("still reports a genuine provider/request timeout as an LLM request timeout", () => {
    // Guard against over-correcting: real provider timeouts must keep their honest copy.
    expect(isTimeoutErrorMessage("LLM request timed out")).toBe(true);
    expect(isTimeoutErrorMessage("stream disconnected: request timed out")).toBe(true);
    expect(formatAssistantErrorText(makeAssistantError("request timed out"))).toBe(
      GENERIC_LLM_TIMEOUT,
    );
  });

  it("does not classify our abort copy as a provider timeout for failover status", () => {
    // run.ts maps isTimeoutErrorMessage(message) -> HTTP 408 (provider timeout). A run-limit
    // or stall abort is not a provider fault, so it must not be reported as a 408.
    expect(isTimeoutErrorMessage(RUN_LIMIT_MESSAGE)).toBe(false);
    expect(isTimeoutErrorMessage(STALL_MESSAGE)).toBe(false);
  });
});

describe("runcap: the run-deadline error raised before a fallback candidate is also honest", () => {
  // assertRunDeadline throws once the whole-run budget is spent, and model-fallback rethrows it
  // instead of starting another candidate — so this text reaches the user directly.
  it("reports the configured limit, not a provider timeout", () => {
    const err = new RunDeadlineExceededError(600_000);

    expect(err.message).toContain("600s");
    expect(err.message.toLowerCase()).not.toContain("llm request timed out");
    expect(isTimeoutErrorMessage(err.message)).toBe(false);
    expect(formatAssistantErrorText(makeAssistantError(err.message))).toBe(err.message);
  });

  it("agrees with the watchdog's run-limit copy (two paths, one story for the user)", () => {
    expect(new RunDeadlineExceededError(600_000).message).toBe(formatRunLimitMessage(600_000));
    expect(new RunDeadlineExceededError(90_000).message).toBe(formatRunLimitMessage(90_000));
  });

  it("is thrown exactly when the deadline has passed, and never for an uncapped run", () => {
    let now = 0;
    const capped = createRunDeadline(60_000, () => now);

    expect(() => assertRunDeadline(capped)).not.toThrow();
    now = 60_000;
    expect(() => assertRunDeadline(capped)).toThrow(RunDeadlineExceededError);

    // An uncapped run must never be stopped by the deadline check.
    let later = 0;
    const uncapped = createRunDeadline(NO_AGENT_TIMEOUT_MS, () => later);
    later = 40 * 60_000;
    expect(() => assertRunDeadline(uncapped)).not.toThrow();
  });
});
