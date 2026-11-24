import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentCompactionIdentifierPolicy } from "../../config/types.agent-defaults.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

export type CompactionSafeguardRuntimeValue = {
  maxHistoryShare?: number;
  contextWindowTokens?: number;
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  identifierInstructions?: string;
  customInstructions?: string;
  /**
   * Model to use for compaction summarization.
   * Passed through runtime because `ctx.model` is undefined in the compact.ts workflow
   * (extensionRunner.initialize() is never called in that path).
   */
  model?: Model<Api>;
  recentTurnsPreserve?: number;
  qualityGuardEnabled?: boolean;
  qualityGuardMaxRetries?: number;
};

const registry = createSessionManagerRuntimeRegistry<CompactionSafeguardRuntimeValue>();

export const setCompactionSafeguardRuntime = registry.set;

export const getCompactionSafeguardRuntime = registry.get;

/**
 * heartbeat-compaction ARCH §2.7: set by the safeguard when it cancels a compaction because there is
 * nothing to summarize, so the caller can tell that outcome apart from a real error (both surface
 * from the session as the same "Compaction cancelled" error).
 */
const nothingToSummarize = createSessionManagerRuntimeRegistry<true>();

export function markCompactionNothingToSummarize(sessionManager: unknown): void {
  nothingToSummarize.set(sessionManager, true);
}

/** Returns whether the safeguard cancelled for nothing to summarize, and clears the mark. */
export function takeCompactionNothingToSummarize(sessionManager: unknown): boolean {
  const marked = nothingToSummarize.get(sessionManager) === true;
  nothingToSummarize.set(sessionManager, null);
  return marked;
}
