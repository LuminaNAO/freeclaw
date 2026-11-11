// docs/design/mail-push.md §9.9: quoted reply chains may be cut, the new text never is.
import { describe, expect, it } from "vitest";
import { cutQuotedReply } from "./format.js";

describe("cutQuotedReply (§9.9)", () => {
  it("keeps a bottom-posted answer that follows the quote", () => {
    const text =
      "Hi Bob\n\n> Can you send the invoice?\n> Thanks\n\nSure, attached.\n\n" +
      "Also: the deadline is Friday and the wire goes to account X.";
    const out = cutQuotedReply(text);
    expect(out).toContain("Hi Bob");
    expect(out).toContain("Sure, attached.");
    expect(out).toContain("Also: the deadline is Friday and the wire goes to account X.");
    expect(out).toContain("[quoted reply cut]");
    expect(out).not.toContain("Can you send the invoice?");
  });

  it("keeps inline answers between quoted runs", () => {
    const text = [
      "On Mon, 9 Nov 2026 at 10:00, Ann <ann@client.com> wrote:",
      "> Question one?",
      "> More context for one.",
      "",
      "Answer one.",
      "",
      "> Question two?",
      ">",
      "> More context for two.",
      "Answer two.",
    ].join("\n");
    const out = cutQuotedReply(text);
    expect(out).toContain("Answer one.");
    expect(out).toContain("Answer two.");
    expect(out).not.toContain("Question one?");
    expect(out).not.toContain("More context for two.");
    expect(out).not.toContain("wrote:");
    expect(out.indexOf("Answer one.")).toBeLessThan(out.indexOf("Answer two."));
  });

  it("cuts a quote at the end together with its wrote: header", () => {
    const out = cutQuotedReply(
      "Sounds good.\n\nOn Mon, 9 Nov 2026 Ann wrote:\n> earlier text\n> more",
    );
    expect(out).toBe("Sounds good.\n\n[quoted reply cut]");
  });

  it("handles a wrote: header wrapped over two lines", () => {
    const out = cutQuotedReply(
      "Thanks!\n\nOn Mon, 9 Nov 2026 at 10:00, Ann Example\n<ann@client.com> wrote:\n> a\n> b",
    );
    expect(out).toBe("Thanks!\n\n[quoted reply cut]");
  });

  it("leaves single quoted lines, text without quotes and quote-only bodies alone", () => {
    expect(cutQuotedReply("> one quoted line\nmy answer")).toBe("> one quoted line\nmy answer");
    expect(cutQuotedReply("plain text\nno quotes")).toBe("plain text\nno quotes");
    expect(cutQuotedReply("> only\n> a quote")).toBe("> only\n> a quote");
  });

  it("keeps text after an Original Message separator", () => {
    const text = "Top reply.\n\n-----Original Message-----\nFrom: Ann\n\nOld text";
    expect(cutQuotedReply(text)).toBe(text);
  });
});
