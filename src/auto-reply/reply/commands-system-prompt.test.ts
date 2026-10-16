import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../agents/cli-runner/helpers.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

// Narration follows delivery §2.4 / §3: callers without a channel context use the agent default.
const ON_LINE = "Default: do not narrate routine, low-risk tool calls (just call the tool).";
const OFF_LINE =
  "Do not write progress or narration between tool calls. Work silently, then write one final reply.";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cmd-prompt-"));
  tempDirs.push(dir);
  return dir;
}

function configWithDefault(blockStreamingDefault?: "on" | "off"): OpenClawConfig {
  return blockStreamingDefault ? { agents: { defaults: { blockStreamingDefault } } } : {};
}

function makeCommandParams(workspaceDir: string, cfg: OpenClawConfig): HandleCommandsParams {
  return {
    cfg,
    ctx: { SessionKey: "agent:main:main" },
    command: {
      commandBodyNormalized: "/context",
      channel: "signal",
      senderIsOwner: true,
    },
    sessionKey: "agent:main:main",
    workspaceDir,
    provider: "openai",
    model: "gpt-5",
    elevated: { allowed: false },
    resolvedThinkLevel: "off",
    resolvedReasoningLevel: "off",
  } as unknown as HandleCommandsParams;
}

describe("command system prompt bundle (narration follows delivery §2.4)", () => {
  for (const blockStreamingDefault of [undefined, "on", "off"] as const) {
    it(`matches the agent default (blockStreamingDefault=${String(blockStreamingDefault)})`, async () => {
      const workspaceDir = await makeWorkspace();
      const cfg = configWithDefault(blockStreamingDefault);
      const { systemPrompt } = await resolveCommandsSystemPromptBundle(
        makeCommandParams(workspaceDir, cfg),
      );
      if (blockStreamingDefault === "off") {
        expect(systemPrompt).toContain(OFF_LINE);
        expect(systemPrompt).not.toContain(ON_LINE);
      } else {
        expect(systemPrompt).toContain(ON_LINE);
        expect(systemPrompt).not.toContain(OFF_LINE);
      }
    });
  }
});

describe("CLI runner system prompt (narration follows delivery §2.4)", () => {
  it("uses the agent default block-streaming state", async () => {
    const workspaceDir = await makeWorkspace();
    for (const blockStreamingDefault of [undefined, "on", "off"] as const) {
      const prompt = buildSystemPrompt({
        workspaceDir,
        config: configWithDefault(blockStreamingDefault),
        tools: [],
        modelDisplay: "openai/gpt-5",
      });
      const expected = blockStreamingDefault === "off" ? "off" : "on";
      expect(prompt, String(blockStreamingDefault)).toContain(
        expected === "off" ? OFF_LINE : ON_LINE,
      );
      expect(prompt, String(blockStreamingDefault)).not.toContain(
        expected === "off" ? ON_LINE : OFF_LINE,
      );
    }
  });

  it("is otherwise the same prompt in both modes", async () => {
    const workspaceDir = await makeWorkspace();
    const on = buildSystemPrompt({
      workspaceDir,
      config: configWithDefault("on"),
      tools: [],
      modelDisplay: "openai/gpt-5",
    });
    const off = buildSystemPrompt({
      workspaceDir,
      config: configWithDefault("off"),
      tools: [],
      modelDisplay: "openai/gpt-5",
    });
    const narrationOf = (mode: "on" | "off") => {
      const lines = buildAgentSystemPrompt({ workspaceDir, blockStreaming: mode }).split("\n");
      const start = lines.indexOf("## Tool Call Style") + 1;
      return lines.slice(start, start + (mode === "on" ? 4 : 2)).join("\n");
    };
    expect(off.replace(narrationOf("off"), narrationOf("on"))).toBe(on);
  });
});
