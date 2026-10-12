import { setCliSessionId } from "../../agents/cli-session.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  mergeSessionEntry,
  setSessionRuntimeModel,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";

type RunResult = Awaited<
  ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>
>;

export async function updateSessionStoreAfterAgentRun(params: {
  cfg: OpenClawConfig;
  contextTokensOverride?: number;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: RunResult;
}) {
  const {
    cfg,
    sessionId,
    sessionKey,
    storePath,
    sessionStore,
    defaultProvider,
    defaultModel,
    fallbackProvider,
    fallbackModel,
    result,
  } = params;

  const usage = result.meta.agentMeta?.usage;
  const promptTokens = result.meta.agentMeta?.promptTokens;
  const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const contextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: providerUsed,
      model: modelUsed,
      contextTokensOverride: params.contextTokensOverride,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  // ARCH §2.1: the end-of-run write is a patch of run-owned fields only, computed
  // against the entry re-read inside the store lock — never the turn-start
  // snapshot, so fields other writers changed during the turn (overrides set by
  // tools, commands or sessions.patch) survive. ARCH §2.2: user-/tool-owned
  // fields are never part of the patch.
  const persisted = await updateSessionStore(storePath, (store) => {
    const existing = store[sessionKey];
    const patch: Partial<SessionEntry> = {
      sessionId,
      updatedAt: Date.now(),
      abortedLastRun: result.meta.aborted ?? false,
    };
    // ARCH §2.3: an override on disk that differs from the model this run used
    // wins; do not pin the runtime model (or its context window) to the run.
    const overrideSelected = hasDifferingModelOverride(existing, {
      provider: providerUsed,
      model: modelUsed,
    });
    if (!overrideSelected) {
      patch.contextTokens = contextTokens;
      setSessionRuntimeModel(patch as SessionEntry, {
        provider: providerUsed,
        model: modelUsed,
      });
    }
    if (isCliProvider(providerUsed, cfg)) {
      const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        const cliPatch: SessionEntry = {
          sessionId,
          updatedAt: patch.updatedAt ?? Date.now(),
          ...(existing?.cliSessionIds ? { cliSessionIds: existing.cliSessionIds } : {}),
        };
        setCliSessionId(cliPatch, providerUsed, cliSessionId);
        if (cliPatch.cliSessionIds) {
          patch.cliSessionIds = cliPatch.cliSessionIds;
        }
        if (cliPatch.claudeCliSessionId) {
          patch.claudeCliSessionId = cliPatch.claudeCliSessionId;
        }
      }
    }
    if (result.meta.systemPromptReport) {
      patch.systemPromptReport = result.meta.systemPromptReport;
    }
    let clearTotalTokens = false;
    if (hasNonzeroUsage(usage)) {
      const totalTokens = deriveSessionTotalTokens({
        usage,
        contextTokens,
        promptTokens,
      });
      patch.inputTokens = usage.input ?? 0;
      patch.outputTokens = usage.output ?? 0;
      if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
        patch.totalTokens = totalTokens;
        patch.totalTokensFresh = true;
      } else {
        // ARCH §2.4: no explicit-undefined keys in the patch; clear after merge.
        clearTotalTokens = true;
        patch.totalTokensFresh = false;
      }
      patch.cacheRead = usage.cacheRead ?? 0;
      patch.cacheWrite = usage.cacheWrite ?? 0;
    }
    if (compactionsThisRun > 0) {
      patch.compactionCount = (existing?.compactionCount ?? 0) + compactionsThisRun;
    }
    const merged = mergeSessionEntry(existing, patch);
    if (clearTotalTokens) {
      delete merged.totalTokens;
    }
    if (overrideSelected) {
      delete merged.model;
      delete merged.modelProvider;
    }
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
}

function hasDifferingModelOverride(
  entry: SessionEntry | undefined,
  used: { provider: string; model: string },
): boolean {
  const overrideModel = entry?.modelOverride?.trim();
  if (!overrideModel) {
    return false;
  }
  if (overrideModel !== used.model.trim()) {
    return true;
  }
  const overrideProvider = entry?.providerOverride?.trim();
  return Boolean(overrideProvider) && overrideProvider !== used.provider.trim();
}
