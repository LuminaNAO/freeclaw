import { describe, expect, it } from "vitest";
import { extractLeadingSimpleCommand } from "./reply-inline.js";

describe("extractLeadingSimpleCommand", () => {
  it("extracts a leading /help command and keeps the rest", () => {
    const result = extractLeadingSimpleCommand("/help some question");
    expect(result?.command).toBe("/help");
    expect(result?.cleaned).toBe("some question");
  });

  it("preserves newlines after extracting a leading command", () => {
    const result = extractLeadingSimpleCommand("/help first line\nsecond line");
    expect(result?.command).toBe("/help");
    expect(result?.cleaned).toBe("first line\nsecond line");
  });

  it("maps a leading /id to /whoami and returns empty cleaned text when standalone", () => {
    expect(extractLeadingSimpleCommand("/id")).toEqual({ command: "/whoami", cleaned: "" });
    expect(extractLeadingSimpleCommand("  /commands  ")).toEqual({
      command: "/commands",
      cleaned: "",
    });
  });

  it("skips an injected timestamp envelope before the command", () => {
    const result = extractLeadingSimpleCommand("[Wed 2026-10-07 18:18 GMT+8] /help me");
    expect(result?.command).toBe("/help");
    expect(result?.cleaned).toBe("[Wed 2026-10-07 18:18 GMT+8] me");
  });

  it.each(["hey /help", "hey /commands", "hey /whoami", "hey /id", "ok /help: thanks"])(
    "treats mid-message %s as plain text",
    (body) => {
      expect(extractLeadingSimpleCommand(body)).toBeNull();
    },
  );

  it("does not match longer words that share a prefix", () => {
    expect(extractLeadingSimpleCommand("/helpful")).toBeNull();
    expect(extractLeadingSimpleCommand("/identity")).toBeNull();
  });

  it("returns null for empty body", () => {
    expect(extractLeadingSimpleCommand("")).toBeNull();
    expect(extractLeadingSimpleCommand(undefined)).toBeNull();
  });
});
