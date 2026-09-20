import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { log } from "./logger.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateContextChars,
  estimateContextCharsBreakdown,
  type ContextCharsBreakdown,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";

// Prune when the wire estimate exceeds this share of the context window.
const CONTEXT_TRIGGER_RATIO = 0.75;
// On trigger, prune every prunable tool result before the message index where
// this share of the estimated prompt falls — one event, then hold that shape.
const PRUNE_BOUNDARY_SHARE = 0.5;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;

/** Session custom entry recording one prune event (pi "custom" entry type). */
export const TOOL_RESULT_PRUNE_CUSTOM_TYPE = "freeclaw.tool-result-prune";

export type ToolResultPruneEntryData = {
  prunedToolUseIds: string[];
  boundaryIndex: number;
  at: number;
};

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
const CONTEXT_LIMIT_TRUNCATION_SUFFIX = `\n${CONTEXT_LIMIT_TRUNCATION_NOTICE}`;

export function buildToolResultPrunedPlaceholder(toolName: string, bytes: number): string {
  return `[pruned: ${toolName} output, ${bytes} bytes — re-run the tool if needed]`;
}

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

/** Minimal structural view of the pi SessionManager the guard needs. */
export type GuardSessionManagerLike = {
  getBranch?: () => unknown[];
  appendCustomEntry?: (customType: string, data?: unknown) => unknown;
};

type GuardRunState = {
  /** Hysteresis: a prune event disarms until the estimate drops back under the
   * trigger, so one crossing of the threshold produces exactly one event. */
  armed: boolean;
  /** Escalation fires at most once per install (per attempt). */
  exhaustedSignaled: boolean;
};

function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  const bodyBudget = Math.max(0, maxChars - CONTEXT_LIMIT_TRUNCATION_SUFFIX.length);
  if (bodyBudget <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", bodyBudget);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  return text.slice(0, cutPoint) + CONTEXT_LIMIT_TRUNCATION_SUFFIX;
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }

  const rawText = getToolResultText(msg);
  if (!rawText) {
    return replaceToolResultText(msg, CONTEXT_LIMIT_TRUNCATION_NOTICE);
  }

  const truncatedText = truncateTextToBudget(rawText, maxChars);
  return replaceToolResultText(msg, truncatedText);
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) {
    return;
  }
  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function toolResultId(msg: AgentMessage): string | undefined {
  const record = msg as { toolCallId?: unknown; tool_call_id?: unknown };
  if (typeof record.toolCallId === "string" && record.toolCallId) {
    return record.toolCallId;
  }
  if (typeof record.tool_call_id === "string" && record.tool_call_id) {
    return record.tool_call_id;
  }
  return undefined;
}

function toolResultName(msg: AgentMessage): string {
  const record = msg as { toolName?: unknown; tool_name?: unknown };
  if (typeof record.toolName === "string" && record.toolName) {
    return record.toolName;
  }
  if (typeof record.tool_name === "string" && record.tool_name) {
    return record.tool_name;
  }
  return "tool";
}

/** Union of all prune entries after the latest compaction on the current branch. */
function readPersistedPrunedIds(sessionManager: GuardSessionManagerLike): Set<string> {
  const ids = new Set<string>();
  if (typeof sessionManager.getBranch !== "function") {
    return ids;
  }
  let branch: unknown[];
  try {
    branch = sessionManager.getBranch();
  } catch {
    return ids;
  }
  let lastCompactionIndex = -1;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i] as { type?: unknown };
    if (entry?.type === "compaction") {
      lastCompactionIndex = i;
    }
  }
  // Entries at or before the latest compaction are superseded: the compaction
  // replaced that history, so their pruned ids no longer map to messages.
  for (let i = lastCompactionIndex + 1; i < branch.length; i++) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry?.type !== "custom" || entry.customType !== TOOL_RESULT_PRUNE_CUSTOM_TYPE) {
      continue;
    }
    const data = entry.data as Partial<ToolResultPruneEntryData> | undefined;
    if (!Array.isArray(data?.prunedToolUseIds)) {
      continue;
    }
    for (const id of data.prunedToolUseIds) {
      if (typeof id === "string" && id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/** Apply persisted prune decisions to the in-memory context. Idempotent. */
function applyPersistedPrunesInPlace(
  messages: AgentMessage[],
  prunedIds: Set<string>,
  cache: MessageCharEstimateCache,
): number {
  if (prunedIds.size === 0) {
    return 0;
  }
  let applied = 0;
  for (const msg of messages) {
    if (!isToolResultMessage(msg)) {
      continue;
    }
    const id = toolResultId(msg);
    if (!id || !prunedIds.has(id)) {
      continue;
    }
    const text = getToolResultText(msg);
    if (text.startsWith("[pruned: ")) {
      continue;
    }
    const placeholder = buildToolResultPrunedPlaceholder(
      toolResultName(msg),
      Buffer.byteLength(text, "utf8"),
    );
    applyMessageMutationInPlace(msg, replaceToolResultText(msg, placeholder), cache);
    applied++;
  }
  return applied;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

/** First index where the cumulative estimate reaches `share` of the total. */
function findBoundaryIndex(
  messages: AgentMessage[],
  cache: MessageCharEstimateCache,
  totalChars: number,
  share: number,
): number {
  const target = totalChars * share;
  let cumulative = 0;
  for (let i = 0; i < messages.length; i++) {
    cumulative += estimateMessageCharsCached(messages[i], cache);
    if (cumulative >= target) {
      return i;
    }
  }
  return messages.length;
}

function formatGuardBreakdown(breakdown: ContextCharsBreakdown): string {
  return (
    `text=${breakdown.textChars} thinking=${breakdown.thinkingChars} ` +
    `tool=${breakdown.toolChars} details=${breakdown.detailsChars}`
  );
}

function enforceToolResultContextBudgetInPlace(params: {
  messages: AgentMessage[];
  triggerChars: number;
  maxSingleToolResultChars: number;
  sessionManager?: GuardSessionManagerLike;
  includeThinking: boolean;
  isToolPrunable: (toolName: string) => boolean;
  onPruneExhausted?: () => void;
  state: GuardRunState;
}): void {
  const {
    messages,
    triggerChars,
    maxSingleToolResultChars,
    sessionManager,
    includeThinking,
    isToolPrunable,
    onPruneExhausted,
    state,
  } = params;
  const estimateCache = createMessageCharEstimateCache({ includeThinking });
  // Breakdown of the raw transcript, before any mutation below, so the log
  // shows what the estimate was counting when the decision was made.
  const breakdown = estimateContextCharsBreakdown(messages, estimateCache);

  // Re-apply persisted prune decisions first: the guard only ever adds ids,
  // so the prompt is deterministic across runs of the same session.
  const persistedIds = sessionManager ? readPersistedPrunedIds(sessionManager) : new Set<string>();
  const appliedPersisted = sessionManager
    ? applyPersistedPrunesInPlace(messages, persistedIds, estimateCache)
    : 0;

  // Original byte sizes, captured before truncation: the prune placeholder
  // must be identical whether produced by a fresh prune (which runs after
  // truncation) or by re-applying the persisted entry (which sees the original
  // text), otherwise the prompt prefix diverges between runs.
  const originalBytesById = new Map<string, number>();
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const id = toolResultId(message);
    if (id) {
      originalBytesById.set(id, Buffer.byteLength(getToolResultText(message), "utf8"));
    }
  }

  // Ensure each tool result has an upper bound before considering total context usage.
  let truncatedCount = 0;
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    if (truncated !== message) {
      truncatedCount++;
    }
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }

  const currentChars = estimateContextChars(messages, estimateCache);
  if (currentChars <= triggerChars) {
    // Back under the trigger: re-arm the hysteresis so the next crossing
    // produces exactly one new prune event.
    state.armed = true;
    state.exhaustedSignaled = false;
    log.info(
      `[tool-result-context-guard] within budget: estimate=${currentChars} ` +
        `trigger=${triggerChars} ${formatGuardBreakdown(breakdown)} ` +
        `appliedPersisted=${appliedPersisted} truncated=${truncatedCount} messages=${messages.length}`,
    );
    return;
  }

  if (!state.armed) {
    log.info(
      `[tool-result-context-guard] over budget (prune event already applied this crossing): ` +
        `estimate=${currentChars} trigger=${triggerChars} ${formatGuardBreakdown(breakdown)} ` +
        `appliedPersisted=${appliedPersisted} truncated=${truncatedCount} messages=${messages.length}`,
    );
    return;
  }

  // One prune event: every prunable tool result before the index where
  // PRUNE_BOUNDARY_SHARE of the estimated prompt falls.
  const boundaryIndex = findBoundaryIndex(
    messages,
    estimateCache,
    currentChars,
    PRUNE_BOUNDARY_SHARE,
  );
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

  const candidates: Array<{ index: number; id: string; name: string; text: string }> = [];
  for (let i = pruneStartIndex; i < boundaryIndex && i < messages.length; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) {
      continue;
    }
    const id = toolResultId(msg);
    if (!id || persistedIds.has(id)) {
      continue;
    }
    const name = toolResultName(msg);
    if (!isToolPrunable(name)) {
      continue;
    }
    const text = getToolResultText(msg);
    if (text.startsWith("[pruned: ")) {
      continue;
    }
    candidates.push({ index: i, id, name, text });
  }

  if (candidates.length === 0) {
    state.armed = false;
    log.warn(
      `[tool-result-context-guard] prune exhausted: estimate=${currentChars} ` +
        `trigger=${triggerChars} boundaryIndex=${boundaryIndex} ` +
        `${formatGuardBreakdown(breakdown)} appliedPersisted=${appliedPersisted} ` +
        `truncated=${truncatedCount} messages=${messages.length}`,
    );
    if (!state.exhaustedSignaled) {
      state.exhaustedSignaled = true;
      onPruneExhausted?.();
    }
    return;
  }

  // Plan the mutations without applying them: the placeholder uses the
  // ORIGINAL (pre-truncation) byte count, matching what a reload derives when
  // re-applying the persisted entry.
  const prunedIds: string[] = [];
  const planned: Array<{ index: number; placeholder: string }> = [];
  let freed = 0;
  for (const candidate of candidates) {
    const msg = messages[candidate.index];
    const before = estimateMessageCharsCached(msg, estimateCache);
    const placeholder = buildToolResultPrunedPlaceholder(
      candidate.name,
      originalBytesById.get(candidate.id) ?? Buffer.byteLength(candidate.text, "utf8"),
    );
    freed +=
      before - estimateMessageCharsCached(replaceToolResultText(msg, placeholder), estimateCache);
    prunedIds.push(candidate.id);
    planned.push({ index: candidate.index, placeholder });
  }

  // Persist BEFORE mutating: if the entry never lands, a reload would rebuild
  // the prompt from raw results and silently diverge from this run. Skipping
  // the mutation keeps in-memory and persisted state in agreement.
  if (sessionManager && typeof sessionManager.appendCustomEntry === "function") {
    try {
      sessionManager.appendCustomEntry(TOOL_RESULT_PRUNE_CUSTOM_TYPE, {
        prunedToolUseIds: prunedIds,
        boundaryIndex,
        at: Date.now(),
      } satisfies ToolResultPruneEntryData);
    } catch (err) {
      // Stay armed: the next transformContext call retries the whole prune,
      // so a transient persistence failure does not disable the guard for the
      // rest of an over-trigger run.
      log.warn(
        `[tool-result-context-guard] failed to persist prune entry; skipping prune this crossing: ${String(err)}`,
      );
      return;
    }
  }

  for (const p of planned) {
    applyMessageMutationInPlace(
      messages[p.index],
      replaceToolResultText(messages[p.index], p.placeholder),
      estimateCache,
    );
  }

  state.armed = false;
  const postChars = estimateContextChars(messages, estimateCache);
  log.info(
    `[tool-result-context-guard] prune event: estimate=${currentChars} trigger=${triggerChars} ` +
      `boundaryIndex=${boundaryIndex} pruned=${prunedIds.length} freed=${freed} ` +
      `postEstimate=${postChars} ${formatGuardBreakdown(breakdown)} ` +
      `appliedPersisted=${appliedPersisted} truncated=${truncatedCount} ` +
      `ids=${prunedIds.join(",")} messages=${messages.length}`,
  );

  if (postChars > triggerChars) {
    // Pruning the whole first half was not enough — the tail alone is over the
    // trigger. Escalate to compaction once and stay disarmed while over.
    if (!state.exhaustedSignaled) {
      state.exhaustedSignaled = true;
      log.warn(
        `[tool-result-context-guard] prune exhausted: postEstimate=${postChars} still over ` +
          `trigger=${triggerChars} after pruning ${prunedIds.length} results`,
      );
      onPruneExhausted?.();
    }
  } else {
    // Back under the trigger: this crossing is complete, the next one is a
    // fresh prune event.
    state.armed = true;
  }
}

export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
  sessionManager?: GuardSessionManagerLike;
  /** Pass false when the provider does not replay thinking blocks (they then
   * never reach the wire and must not count against the budget). Default true. */
  includeThinking?: boolean;
  /** Which tools' results may be pruned (from context-pruning tools allow/deny).
   * Default: all tools prunable. */
  isToolPrunable?: (toolName: string) => boolean;
  /** Called once per install when the guard is over trigger with nothing left
   * to prune — the signal to escalate to full compaction. */
  onPruneExhausted?: () => void;
}): () => void {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const triggerChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_TRIGGER_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE),
  );
  const includeThinking = params.includeThinking ?? true;
  const isToolPrunable = params.isToolPrunable ?? (() => true);
  const state: GuardRunState = { armed: true, exhaustedSignaled: false };

  // Agent.transformContext is private in pi-coding-agent, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const contextMessages = Array.isArray(transformed) ? transformed : messages;
    enforceToolResultContextBudgetInPlace({
      messages: contextMessages,
      triggerChars,
      maxSingleToolResultChars,
      sessionManager: params.sessionManager,
      includeThinking,
      isToolPrunable,
      onPruneExhausted: params.onPruneExhausted,
      state,
    });

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
