import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import {
  applySessionContextLimit,
  CONTEXT_LIMIT_CLEAR_WORD,
  normalizeSessionContextLimit,
} from "../agents/session-context-limit.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatTokenCount } from "../utils/usage-format.js";

export type SessionContextWindowSource = "model" | "agentContextTokens" | "sessionContextLimit";

export type SessionContextWindowSummary = {
  /** Effective window: the lowest of the three below. */
  tokens: number;
  source: SessionContextWindowSource;
  modelTokens: number;
  agentContextTokens?: number;
  contextLimit?: number;
};

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Session context limit ARCH §1.2 for displays (`/context limit`, the `session_status` tool):
 * lowest of the model window, `agents.defaults.contextTokens` and the session's `contextLimit`,
 * with the source of the winner. Ties go to the earlier source (a limit equal to the model
 * window has no effect).
 */
export function resolveSessionContextWindowSummary(params: {
  cfg: OpenClawConfig | undefined;
  provider?: string;
  model?: string;
  entry?: Pick<SessionEntry, "contextLimit">;
}): SessionContextWindowSummary {
  const modelTokens =
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    }) ?? DEFAULT_CONTEXT_TOKENS;
  const agentContextTokens = positiveInt(params.cfg?.agents?.defaults?.contextTokens);
  const contextLimit = normalizeSessionContextLimit(params.entry?.contextLimit);
  const capped =
    agentContextTokens !== undefined && agentContextTokens < modelTokens
      ? { tokens: agentContextTokens, source: "agentContextTokens" as const }
      : { tokens: modelTokens, source: "model" as const };
  const { tokens, source } = applySessionContextLimit(capped, contextLimit) as {
    tokens: number;
    source: SessionContextWindowSource;
  };
  return { tokens, source, modelTokens, agentContextTokens, contextLimit };
}

const SOURCE_LABELS: Record<SessionContextWindowSource, string> = {
  model: "model",
  agentContextTokens: "agents.defaults.contextTokens",
  sessionContextLimit: "session limit",
};

export function formatSessionContextLimitLines(summary: SessionContextWindowSummary): string[] {
  const limitLine =
    summary.contextLimit === undefined
      ? `Context limit: none (${CONTEXT_LIMIT_CLEAR_WORD})`
      : `Context limit: ${formatTokenCount(summary.contextLimit)} (${summary.contextLimit} tokens)`;
  const details = [`source: ${SOURCE_LABELS[summary.source]}`];
  if (summary.source !== "model") {
    details.push(`model ${formatTokenCount(summary.modelTokens)}`);
  }
  if (summary.source === "sessionContextLimit" && summary.agentContextTokens !== undefined) {
    details.push(`agents.defaults.contextTokens ${formatTokenCount(summary.agentContextTokens)}`);
  }
  return [
    limitLine,
    `Effective window: ${formatTokenCount(summary.tokens)} (${details.join("; ")})`,
  ];
}

/**
 * Session context limit ARCH §1.2/§4 for session listings. Only when the session has a limit:
 * the effective window, the limit and the source of the window. Returns `undefined` when there is
 * no limit, so listings without one stay exactly as they were.
 */
export function resolveListedSessionContextLimit(params: {
  cfg: OpenClawConfig | undefined;
  provider?: string;
  model?: string;
  entry?: Pick<SessionEntry, "contextLimit">;
}):
  | { contextTokens: number; contextLimit: number; contextSource: SessionContextWindowSource }
  | undefined {
  const contextLimit = normalizeSessionContextLimit(params.entry?.contextLimit);
  if (contextLimit === undefined) {
    return undefined;
  }
  const summary = resolveSessionContextWindowSummary(params);
  return { contextTokens: summary.tokens, contextLimit, contextSource: summary.source };
}
