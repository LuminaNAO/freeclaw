import { describe, expect, it } from "vitest";
import {
  isAnthropicProviderFamily,
  isOpenAiProviderFamily,
  requiresOpenAiCompatibleAnthropicToolPayload,
  resolveProviderCapabilities,
  resolveTranscriptToolCallIdMode,
  shouldDropThinkingBlocksForModel,
  shouldSanitizeGeminiThoughtSignaturesForModel,
  supportsOpenAiCompatTurnValidation,
} from "./provider-capabilities.js";

describe("resolveProviderCapabilities", () => {
  it("returns native anthropic defaults for ordinary providers", () => {
    expect(resolveProviderCapabilities("anthropic")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      providerFamily: "anthropic",
      preserveAnthropicThinkingSignatures: true,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: ["claude"],
    });
    expect(resolveProviderCapabilities("amazon-bedrock")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      providerFamily: "anthropic",
      preserveAnthropicThinkingSignatures: true,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: ["claude"],
    });
  });

  it("normalizes kimi aliases to the same capability set", () => {
    expect(resolveProviderCapabilities("kimi-coding")).toEqual(
      resolveProviderCapabilities("kimi-code"),
    );
    expect(resolveProviderCapabilities("kimi-code")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      providerFamily: "default",
      preserveAnthropicThinkingSignatures: false,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: [],
    });
  });

  it("flags providers that opt out of OpenAI-compatible turn validation", () => {
    expect(supportsOpenAiCompatTurnValidation("openrouter")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("opencode")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("opencode-go")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("moonshot")).toBe(true);
  });

  it("resolves transcript thought-signature and tool-call quirks through the registry", () => {
    expect(
      shouldSanitizeGeminiThoughtSignaturesForModel({
        provider: "openrouter",
        modelId: "google/gemini-2.5-pro-preview",
      }),
    ).toBe(true);
    expect(
      shouldSanitizeGeminiThoughtSignaturesForModel({
        provider: "kilocode",
        modelId: "gemini-2.0-flash",
      }),
    ).toBe(true);
    expect(
      shouldSanitizeGeminiThoughtSignaturesForModel({
        provider: "opencode-go",
        modelId: "google/gemini-2.5-pro-preview",
      }),
    ).toBe(true);
    expect(resolveTranscriptToolCallIdMode("mistral", "mistral-large-latest")).toBe("strict9");
  });

  it("treats kimi aliases as native anthropic tool payload providers", () => {
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-coding")).toBe(false);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-code")).toBe(false);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("anthropic")).toBe(false);
  });

  it("tracks provider families and model-specific transcript quirks in the registry", () => {
    expect(isOpenAiProviderFamily("openai")).toBe(true);
    expect(isAnthropicProviderFamily("amazon-bedrock")).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      }),
    ).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "amazon-bedrock",
        modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      }),
    ).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "github-copilot",
        modelId: "claude-3.7-sonnet",
      }),
    ).toBe(true);
  });

  it("drops thinking blocks for llama.cpp local models", () => {
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "llama.cpp",
        modelId: "gemma-4-26B-A4B-it-Q8_0.gguf",
      }),
    ).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "llama.cpp",
        modelId: "Qwen3.5-35B-A3B.gguf",
      }),
    ).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "llama.cpp",
        modelId: "deepseek-r1-0528-Q4_K_M.gguf",
      }),
    ).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "llama.cpp",
        modelId: "Meta-Llama-3.1-70B-Instruct.gguf",
      }),
    ).toBe(true);
  });

  it("does not preserve anthropic thinking signatures for llama.cpp", () => {
    const caps = resolveProviderCapabilities("llama.cpp");
    expect(caps.preserveAnthropicThinkingSignatures).toBe(false);
  });
});
