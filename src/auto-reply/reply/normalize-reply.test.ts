import { describe, expect, it } from "vitest";
import { normalizeReplyPayload } from "./normalize-reply.js";

describe("normalizeReplyPayload silent token handling", () => {
  it("drops an exact NO_REPLY", () => {
    const skips: string[] = [];
    expect(
      normalizeReplyPayload({ text: "NO_REPLY" }, { onSkip: (r) => skips.push(r) }),
    ).toBeNull();
    expect(skips).toEqual(["silent"]);
  });

  it("strips a trailing token and delivers the body (#30916)", () => {
    expect(normalizeReplyPayload({ text: "Done.\n\nNO_REPLY" })?.text).toBe("Done.");
  });

  it("strips a LEADING token and delivers the body (local models bundle it)", () => {
    expect(normalizeReplyPayload({ text: "NO_REPLY\nHere is the answer." })?.text).toBe(
      "Here is the answer.",
    );
    expect(normalizeReplyPayload({ text: "NO_REPLY: ok" })?.text).toBe("ok");
  });

  it("strips both edges", () => {
    expect(normalizeReplyPayload({ text: "NO_REPLY ok NO_REPLY" })?.text).toBe("ok");
  });

  it("keeps media when only the token was around it", () => {
    const out = normalizeReplyPayload({ text: "NO_REPLY", mediaUrl: "file:///tmp/a.png" });
    expect(out?.mediaUrl).toBe("file:///tmp/a.png");
    expect(out?.text ?? "").toBe("");
  });

  it("never touches an embedded or word-joined token", () => {
    expect(normalizeReplyPayload({ text: "Please NO_REPLY to this" })?.text).toBe(
      "Please NO_REPLY to this",
    );
  });
});
