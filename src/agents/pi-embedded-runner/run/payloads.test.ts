import { describe, expect, it } from "vitest";
import { buildPayloads, expectSingleToolErrorPayload } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  it("suppresses exec tool errors when verbose mode is off", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "off",
    });

    expect(payloads).toHaveLength(0);
  });

  it("shows exec tool errors when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail: "command failed",
    });
  });

  it("keeps non-exec mutating tool failures visible", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      absentDetail: "permission denied",
    });
  });

  it.each([
    {
      name: "includes details for mutating tool failures when verbose is on",
      verboseLevel: "on" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
    {
      name: "includes details for mutating tool failures when verbose is full",
      verboseLevel: "full" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
  ])("$name", ({ verboseLevel, detail, absentDetail }) => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel,
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail,
      absentDetail,
    });
  });

  it("suppresses sessions_send errors to avoid leaking transient relay failures", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "sessions_send", error: "delivery timeout" },
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(0);
  });

  it("suppresses sessions_send errors even when marked mutating", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "sessions_send",
        error: "delivery timeout",
        mutatingAction: true,
      },
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(0);
  });

  it("suppresses assistant text when a deterministic exec approval prompt was already delivered", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Approval is needed. Please run /approve abc allow-once"],
      didSendDeterministicApprovalPrompt: true,
    });

    expect(payloads).toHaveLength(0);
  });
});

describe("buildEmbeddedRunPayloads messaging fallback reconciliation", () => {
  const sameTarget = { tool: "message", provider: "telegram", to: "telegram:123" };
  const origin = { provider: "telegram", to: "telegram:123" };
  const failedSendError = {
    toolName: "message",
    error: 'Poll fields require action "poll"; use action "poll" instead of "send".',
    mutatingAction: true,
    actionFingerprint: "tool=message|action=send|to=telegram:123",
    mediaUrls: ["./generated-image.png"],
    target: sameTarget,
  };

  function countMediaPayloads(
    payloads: ReturnType<typeof buildPayloads>,
    mediaUrl: string,
  ): number {
    return payloads.filter(
      (p) => p.mediaUrl === mediaUrl || (p.mediaUrls?.includes(mediaUrl) ?? false),
    ).length;
  }

  it("omits the stale failure warning when the same-target failed send's media is delivered by the inline fallback", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Here is the image\nMEDIA:./generated-image.png"],
      lastToolError: failedSendError,
      origin,
    });

    expect(countMediaPayloads(payloads, "./generated-image.png")).toBe(1);
    expect(payloads.some((p) => p.isError)).toBe(false);
    expect(payloads.some((p) => p.text?.includes("failed"))).toBe(false);
  });

  it("keeps the warning when the failed send targeted a different conversation", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Here is the image\nMEDIA:./generated-image.png"],
      lastToolError: {
        ...failedSendError,
        target: { tool: "message", provider: "telegram", to: "telegram:999" },
      },
      origin,
    });

    expect(countMediaPayloads(payloads, "./generated-image.png")).toBe(1);
    expect(payloads.some((p) => p.isError && p.text?.includes("failed"))).toBe(true);
  });

  it("keeps the warning when the failed send targeted a different provider", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Here is the image\nMEDIA:./generated-image.png"],
      lastToolError: {
        ...failedSendError,
        target: { tool: "message", provider: "slack", to: "channel:C123" },
      },
      origin,
    });

    expect(payloads.some((p) => p.isError && p.text?.includes("failed"))).toBe(true);
  });

  it("keeps the warning when origin routing is unknown", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Here is the image\nMEDIA:./generated-image.png"],
      lastToolError: failedSendError,
    });

    expect(payloads.some((p) => p.isError && p.text?.includes("failed"))).toBe(true);
  });

  it("keeps the warning when the failed send has no captured target", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Here is the image\nMEDIA:./generated-image.png"],
      lastToolError: { ...failedSendError, target: undefined },
      origin,
    });

    expect(payloads.some((p) => p.isError && p.text?.includes("failed"))).toBe(true);
  });

  it("keeps the warning when no equivalent fallback media is delivered", () => {
    const payloads = buildPayloads({
      assistantTexts: ["I could not deliver the image."],
      lastToolError: failedSendError,
      origin,
    });

    expect(payloads.some((p) => p.isError && p.text?.includes("failed"))).toBe(true);
  });

  it("keeps the warning when the delivered media differs from the failed send's media", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Here is a different image\nMEDIA:./other-image.png"],
      lastToolError: failedSendError,
      origin,
    });

    expect(countMediaPayloads(payloads, "./other-image.png")).toBe(1);
    expect(payloads.some((p) => p.isError && p.text?.includes("failed"))).toBe(true);
  });

  it("keeps the warning for failed mutating sends without media", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Here is the image\nMEDIA:./generated-image.png"],
      lastToolError: {
        toolName: "message",
        error: "target not found",
        mutatingAction: true,
        actionFingerprint: "tool=message|action=send|to=telegram:123",
        target: sameTarget,
      },
      origin,
    });

    expect(payloads.some((p) => p.isError && p.text?.includes("failed"))).toBe(true);
  });

  it("matches fallback media across file:// and ./ prefix variants", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Here is the image\nMEDIA:./generated-image.png"],
      lastToolError: {
        ...failedSendError,
        mediaUrls: ["file://generated-image.png"],
      },
      origin,
    });

    expect(payloads.some((p) => p.isError)).toBe(false);
  });
});
