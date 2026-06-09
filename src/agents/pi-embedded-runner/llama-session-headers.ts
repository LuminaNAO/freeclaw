import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { DEFAULT_AGENT_ID, toAgentStoreSessionKey } from "../../routing/session-key.js";

export type OpenClawLlamaHeaderInfo = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  agentKind?: "main" | "subagent";
  cachePolicy?: "hdd" | "no-hdd";
  runId?: string;
  trigger?: string;
};

export function resolveOpenClawLlamaHeaderSessionId(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): string {
  const sessionKey = params.sessionKey?.trim();
  if (sessionKey) {
    return sessionKey;
  }
  return toAgentStoreSessionKey({
    agentId: params.agentId ?? DEFAULT_AGENT_ID,
    requestKey: params.sessionId,
  });
}

export function resolveOpenClawLlamaCachePolicy(params: {
  agentKind?: "main" | "subagent";
  trigger?: string;
}): "hdd" | "no-hdd" {
  if (params.agentKind === "subagent") {
    return "no-hdd";
  }
  const trigger = params.trigger?.trim().toLowerCase();
  if (trigger && trigger !== "user") {
    return "no-hdd";
  }
  return "hdd";
}

function cleanHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.replace(/[\r\n\t]/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.slice(0, 512);
}

export function buildOpenClawLlamaHeaders(info: OpenClawLlamaHeaderInfo): Record<string, string> {
  const headers: Record<string, string> = {};
  const values: Array<[string, unknown]> = [
    ["X-OpenClaw-Session-Id", info.sessionId],
    ["X-OpenClaw-Session-Key", info.sessionKey],
    ["X-OpenClaw-Agent-Id", info.agentId],
    ["X-OpenClaw-Agent-Kind", info.agentKind],
    ["X-OpenClaw-Cache-Policy", info.cachePolicy],
    ["X-OpenClaw-Run-Id", info.runId],
    ["X-OpenClaw-Trigger", info.trigger],
  ];

  for (const [key, value] of values) {
    const cleaned = cleanHeaderValue(value);
    if (cleaned) {
      headers[key] = cleaned;
    }
  }
  return headers;
}

function isLoopbackBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function normalizeProviderValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function shouldInjectOpenClawLlamaHeaders(params: {
  provider?: string;
  model?: { api?: unknown; provider?: unknown; baseUrl?: unknown };
}): boolean {
  const provider = normalizeProviderValue(params.provider ?? params.model?.provider);
  const modelProvider = normalizeProviderValue(params.model?.provider);
  if (provider === "llama.cpp" || modelProvider === "llama.cpp") {
    return true;
  }
  if (provider.includes("llama.cpp") || modelProvider.includes("llama.cpp")) {
    return true;
  }
  return isLoopbackBaseUrl(params.model?.baseUrl);
}

export function createOpenClawLlamaHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  info: OpenClawLlamaHeaderInfo,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const openClawHeaders = buildOpenClawLlamaHeaders(info);
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        ...openClawHeaders,
      },
    });
}
