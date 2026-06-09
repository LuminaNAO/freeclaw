import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildOpenClawLlamaHeaders,
  createOpenClawLlamaHeadersWrapper,
  shouldInjectOpenClawLlamaHeaders,
} from "./llama-session-headers.js";

function captureHeaders(info: Parameters<typeof createOpenClawLlamaHeadersWrapper>[1]) {
  let captured: Record<string, string> | undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    captured = options?.headers;
    return createAssistantMessageEventStream();
  };
  const wrapped = createOpenClawLlamaHeadersWrapper(baseStreamFn, info);
  const model = {
    api: "anthropic-messages",
    provider: "llama.cpp",
    id: "Qwen3.6-27B-UD-Q4_K_XL.gguf",
  } as Model<"anthropic-messages">;
  const context: Context = { messages: [] };

  void wrapped(model, context, {
    headers: { "X-Existing": "keep", "X-OpenClaw-Session-Id": "caller" },
  });
  return captured;
}

describe("OpenClaw llama session headers", () => {
  it("builds stable session and agent headers", () => {
    const headers = buildOpenClawLlamaHeaders({
      sessionId: "session-1",
      sessionKey: "agent:main:subagent:planner",
      agentId: "main",
      agentKind: "subagent",
      runId: "run-1",
      trigger: "user",
    });

    expect(headers).toEqual({
      "X-OpenClaw-Session-Id": "session-1",
      "X-OpenClaw-Session-Key": "agent:main:subagent:planner",
      "X-OpenClaw-Agent-Id": "main",
      "X-OpenClaw-Agent-Kind": "subagent",
      "X-OpenClaw-Run-Id": "run-1",
      "X-OpenClaw-Trigger": "user",
    });
  });

  it("sanitizes header values", () => {
    const headers = buildOpenClawLlamaHeaders({
      sessionId: "session\n1",
      sessionKey: " key\twith\rcontrol ",
    });

    expect(headers["X-OpenClaw-Session-Id"]).toBe("session 1");
    expect(headers["X-OpenClaw-Session-Key"]).toBe("key with control");
  });

  it("injects headers and lets OpenClaw identity override caller headers", () => {
    const headers = captureHeaders({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      agentKind: "main",
    });

    expect(headers?.["X-Existing"]).toBe("keep");
    expect(headers?.["X-OpenClaw-Session-Id"]).toBe("session-1");
    expect(headers?.["X-OpenClaw-Agent-Kind"]).toBe("main");
  });

  it("enables headers for llama.cpp and loopback model endpoints only", () => {
    expect(
      shouldInjectOpenClawLlamaHeaders({
        provider: "llama.cpp",
        model: { api: "anthropic-messages", provider: "llama.cpp", baseUrl: "https://remote" },
      }),
    ).toBe(true);
    expect(
      shouldInjectOpenClawLlamaHeaders({
        provider: "custom",
        model: { api: "anthropic-messages", provider: "custom", baseUrl: "http://127.0.0.1:40801" },
      }),
    ).toBe(true);
    expect(
      shouldInjectOpenClawLlamaHeaders({
        provider: "anthropic",
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
        },
      }),
    ).toBe(false);
  });
});
