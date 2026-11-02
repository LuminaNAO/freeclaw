import { describe, expect, it } from "vitest";
import {
  SUBAGENT_SLUG_MAX_CHARS,
  SUBAGENT_SLUG_MAX_WORDS,
  resolveSubagentLabel,
  slugifySubagentTask,
} from "./subagent-names.js";

describe("slugifySubagentTask (ARCH subagent-session-names §1)", () => {
  it("lowercases and joins at most 6 words from the first non-empty line", () => {
    expect(
      slugifySubagentTask("\n\nCheck Disk Usage On All Mounted Volumes Today\nsecond line"),
    ).toBe("check-disk-usage-on-all-mounted");
  });

  it("stays within 40 chars", () => {
    const slug = slugifySubagentTask("internationalization ".repeat(5));
    expect(slug.length).toBeLessThanOrEqual(SUBAGENT_SLUG_MAX_CHARS);
    expect(slug.split("-").length).toBeLessThanOrEqual(SUBAGENT_SLUG_MAX_WORDS);
    expect(slugifySubagentTask("x".repeat(100)).length).toBe(SUBAGENT_SLUG_MAX_CHARS);
  });

  it.each([
    ["see https://example.com/a/b?c=d and report", "see-and-report"],
    ["read ./src/foo/bar.ts and ~/notes.md then fix", "read-and-then-fix"],
    ["read C:\\Users\\me\\file.txt carefully", "read-carefully"],
    ["session 5b6f3f0e-aaaa-4bbb-8ccc-0123456789ab failed", "session-failed"],
    ["agent:main:subagent:5b6f3f0e-aaaa-4bbb-8ccc-0123456789ab died", "died"],
    ["mail bob@example.com about build 20260101123", "mail-about-build"],
  ])("drops paths, URLs, uuids and ids: %s", (task, expected) => {
    const slug = slugifySubagentTask(task);
    expect(slug).toBe(expected);
    expect(slug).not.toMatch(/[/\\:@~]|https?|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("falls back to a fixed word when nothing usable is left", () => {
    expect(slugifySubagentTask("")).toBe("subagent");
    expect(slugifySubagentTask("https://example.com/only")).toBe("subagent");
  });

  it("keeps an explicit label as given (trimmed)", () => {
    expect(resolveSubagentLabel({ label: "  My Label  ", task: "ignored" })).toBe("My Label");
    expect(resolveSubagentLabel({ task: "Do the thing" })).toBe("do-the-thing");
  });
});
