// Focus section of the system prompt and its survival through compaction
// (focus-mode ARCH §7.5, tests §7.6).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearAllFocus, setSessionFocus } from "../infra/focus-mode.js";
import {
  buildFocusPromptSection,
  FOCUS_PROMPT_HEADING,
  FOCUS_PROMPT_MAX_CHARS,
  FOCUS_PROMPT_MAX_LINES,
  resolveFocusPromptState,
} from "./focus-prompt.js";
import {
  FOCUS_COMPACTION_RULE,
  resolveCompactionInstructions,
} from "./pi-extensions/compaction-instructions.js";
import { __testing as safeguardTesting } from "./pi-extensions/compaction-safeguard.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

function focusSection(prompt: string): string {
  const start = prompt.indexOf(`${FOCUS_PROMPT_HEADING}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = prompt.slice(start + FOCUS_PROMPT_HEADING.length + 1);
  const next = rest.search(/\n#{1,2} /);
  return `${FOCUS_PROMPT_HEADING}\n${next < 0 ? rest : rest.slice(0, next)}`.trim();
}

describe("Focus section in the system prompt (focus-mode ARCH §7.5)", () => {
  it("every new session gets it: what focus is, the tiers, the rule, the commands, operator only", () => {
    const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw" });
    const section = focusSection(prompt);
    expect(section).toContain("none < normal < hyper");
    expect(section).toContain("active level is the highest tier any session holds");
    expect(section).toContain("runs only if its tier >= the active level");
    expect(section).toContain("/focus here|<session key> [normal|hyper]");
    expect(section).toContain("/focus off here|<session key>");
    expect(section).toContain("/focus off (clear all)");
    expect(section).toContain("Only an operator can set or clear focus");
    expect(section).not.toMatch(/\/focusmode|\/unfocus/);
  });

  it("subagent (minimal) prompts carry it too; the bare `none` prompt does not", () => {
    expect(
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        promptMode: "minimal",
      }),
    ).toContain(`${FOCUS_PROMPT_HEADING}\n`);
    expect(
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        promptMode: "none",
      }),
    ).not.toContain(FOCUS_PROMPT_HEADING);
  });

  it("is size-capped: five lines at most, with or without the state line", () => {
    for (const state of [
      undefined,
      { active: "hyper", tier: "normal" },
      { active: "normal", tier: "normal" },
    ]) {
      const lines = buildFocusPromptSection(state);
      expect(lines[0]).toBe(FOCUS_PROMPT_HEADING);
      expect(lines.at(-1)).toBe("");
      const body = lines.slice(1, -1);
      expect(body.length).toBeLessThanOrEqual(FOCUS_PROMPT_MAX_LINES);
      expect(lines.join("\n").length).toBeLessThanOrEqual(FOCUS_PROMPT_MAX_CHARS);
    }
  });

  it("no focus state: no state line", () => {
    const plain = buildFocusPromptSection();
    expect(buildFocusPromptSection({ active: "none", tier: "none" })).toEqual(plain);
    expect(plain.join("\n")).not.toContain("Focus is on");
  });

  it("with focus state: the active level and whether this session is focused", () => {
    const focused = focusSection(
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        focus: { active: "hyper", tier: "hyper" },
      }),
    );
    expect(focused).toContain(
      "Focus is on: active level hyper; this session is focused at hyper, so its people's messages run.",
    );

    const waiting = focusSection(
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        focus: { active: "hyper", tier: "normal" },
      }),
    );
    expect(waiting).toContain("this session is focused at normal, so its people's messages wait.");

    const notFocused = focusSection(
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        focus: { active: "normal", tier: "none" },
      }),
    );
    expect(notFocused).toContain(
      "Focus is on: active level normal; this session is not focused, so its people's messages wait.",
    );
  });
});

describe("the Focus section's state comes from focus.json (focus-mode ARCH §7.5)", () => {
  it("no focus: no state; mixed tiers: the active level and this session's tier", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-prompt-"));
    try {
      expect(resolveFocusPromptState("agent:main:main", stateDir)).toBeUndefined();
      setSessionFocus({ sessionKey: "agent:main:main", by: "op", stateDir });
      setSessionFocus({ sessionKey: "agent:main:x", tier: "hyper", by: "op", stateDir });
      expect(resolveFocusPromptState("agent:main:main", stateDir)).toEqual({
        active: "hyper",
        tier: "normal",
      });
      expect(resolveFocusPromptState("AGENT:main:x", stateDir)).toEqual({
        active: "hyper",
        tier: "hyper",
      });
      expect(resolveFocusPromptState("agent:main:other", stateDir)).toEqual({
        active: "hyper",
        tier: "none",
      });
      expect(resolveFocusPromptState(undefined, stateDir)).toEqual({
        active: "hyper",
        tier: "none",
      });
      clearAllFocus(stateDir);
      expect(resolveFocusPromptState("agent:main:main", stateDir)).toBeUndefined();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("compaction keeps the Focus section (focus-mode ARCH §7.5)", () => {
  it("the standing rule names the section and its rules", () => {
    expect(FOCUS_COMPACTION_RULE).toContain("## Focus");
    expect(FOCUS_COMPACTION_RULE).toContain("none < normal < hyper");
    expect(FOCUS_COMPACTION_RULE).toContain("/focus");
  });

  it("is part of the summary instructions with and without custom /compact text", () => {
    const plain = safeguardTesting.buildCompactionStructureInstructions(
      resolveCompactionInstructions(undefined, undefined),
    );
    expect(plain).toContain(FOCUS_COMPACTION_RULE);
    // A custom instruction at the 800-char cap does not push the rule out.
    const long = safeguardTesting.buildCompactionStructureInstructions(
      resolveCompactionInstructions("x".repeat(5000), undefined),
    );
    expect(long).toContain(FOCUS_COMPACTION_RULE);
    // Before the untrusted custom block, so the custom text cannot reframe it.
    expect(long.indexOf(FOCUS_COMPACTION_RULE)).toBeLessThan(long.indexOf("<untrusted-text>"));
  });
});
