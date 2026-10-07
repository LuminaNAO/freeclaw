import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, streamSimpleAnthropic } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

// ARCH model-output-token-cap §3.1-3.2.

const context: Context = { messages: [] };

function completionsModel(maxTokens: number | undefined): Model<"openai-completions"> {
  return {
    api: "openai-completions",
    provider: "local",
    id: "big-model",
    name: "big-model",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens,
  } as unknown as Model<"openai-completions">;
}

function cfgWithParams(params: Record<string, unknown>): OpenClawConfig {
  return {
    agents: { defaults: { models: { "local/big-model": { params } } } },
  } as OpenClawConfig;
}

function captureMaxTokens(params: {
  cfg?: OpenClawConfig;
  modelMaxTokens: number | undefined;
  callerOptions?: SimpleStreamOptions;
}): { called: boolean; maxTokens: number | undefined } {
  const captured: { called: boolean; maxTokens: number | undefined } = {
    called: false,
    maxTokens: undefined,
  };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    captured.called = true;
    captured.maxTokens = options?.maxTokens;
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };
  applyExtraParamsToAgent(agent, params.cfg, "local", "big-model");
  void agent.streamFn?.(completionsModel(params.modelMaxTokens), context, params.callerOptions);
  return captured;
}

describe("extra-params: model maxTokens output cap (ARCH §3.1)", () => {
  it("uses the model maxTokens when no params are set", () => {
    const result = captureMaxTokens({ modelMaxTokens: 128_000 });
    expect(result.called).toBe(true);
    expect(result.maxTokens).toBe(128_000);
  });

  it("lets an explicit params.maxTokens below the model cap win", () => {
    const result = captureMaxTokens({
      cfg: cfgWithParams({ maxTokens: 50_000 }),
      modelMaxTokens: 128_000,
    });
    expect(result.maxTokens).toBe(50_000);
  });

  it("clamps an explicit params.maxTokens above the model cap", () => {
    const result = captureMaxTokens({
      cfg: cfgWithParams({ maxTokens: 200_000 }),
      modelMaxTokens: 128_000,
    });
    expect(result.maxTokens).toBe(128_000);
  });

  it("clamps a per-agent params.maxTokens above the model cap", () => {
    const captured: { maxTokens?: number } = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      captured.maxTokens = options?.maxTokens;
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: { list: [{ id: "writer", params: { maxTokens: 300_000 } }] },
    } as OpenClawConfig;
    applyExtraParamsToAgent(agent, cfg, "local", "big-model", undefined, undefined, "writer");
    void agent.streamFn?.(completionsModel(128_000), context, undefined);
    expect(captured.maxTokens).toBe(128_000);
  });

  it("leaves maxTokens unset for a model without maxTokens (library default applies)", () => {
    const result = captureMaxTokens({ modelMaxTokens: undefined });
    expect(result.called).toBe(true);
    expect(result.maxTokens).toBeUndefined();
  });

  it("passes explicit params through unchanged for a model without maxTokens", () => {
    const result = captureMaxTokens({
      cfg: cfgWithParams({ maxTokens: 50_000 }),
      modelMaxTokens: undefined,
    });
    expect(result.maxTokens).toBe(50_000);
  });
});

function anthropicModel(maxTokens: number): Model<"anthropic-messages"> {
  return {
    api: "anthropic-messages",
    provider: "anthropic",
    id: "claude-3-7-sonnet-20250219",
    name: "claude-3-7-sonnet",
    baseUrl: "http://127.0.0.1:1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens,
  } as unknown as Model<"anthropic-messages">;
}

async function captureAnthropicThinkingPayload(params: {
  cfg?: OpenClawConfig;
  modelMaxTokens: number;
}): Promise<Record<string, unknown> | undefined> {
  let payload: Record<string, unknown> | undefined;
  const agent: { streamFn?: StreamFn } = { streamFn: streamSimpleAnthropic as StreamFn };
  applyExtraParamsToAgent(
    agent,
    params.cfg,
    "anthropic",
    "claude-3-7-sonnet-20250219",
    undefined,
    "high",
  );
  const stream = await agent.streamFn?.(anthropicModel(params.modelMaxTokens), context, {
    apiKey: "test-key",
    reasoning: "high",
    onPayload: (body: unknown) => {
      payload = body as Record<string, unknown>;
      // Stop before any network request.
      throw new Error("payload captured");
    },
  });
  await stream?.result();
  return payload;
}

describe("extra-params: model maxTokens cap with thinking (ARCH §3.2)", () => {
  it("keeps the thinking budget inside the model cap", async () => {
    const payload = await captureAnthropicThinkingPayload({ modelMaxTokens: 128_000 });
    expect(payload?.max_tokens).toBe(128_000);
    const thinking = payload?.thinking as { type?: string; budget_tokens?: number } | undefined;
    expect(thinking?.type).toBe("enabled");
    expect(thinking?.budget_tokens).toBe(16_384);
    expect(thinking?.budget_tokens ?? Infinity).toBeLessThan(Number(payload?.max_tokens));
  });

  it("adds the thinking budget on top of an explicit maxTokens, still within the cap", async () => {
    const payload = await captureAnthropicThinkingPayload({
      cfg: {
        agents: {
          defaults: {
            models: { "anthropic/claude-3-7-sonnet-20250219": { params: { maxTokens: 50_000 } } },
          },
        },
      } as OpenClawConfig,
      modelMaxTokens: 128_000,
    });
    expect(payload?.max_tokens).toBe(66_384);
    const thinking = payload?.thinking as { budget_tokens?: number } | undefined;
    expect(thinking?.budget_tokens).toBe(16_384);
  });
});
