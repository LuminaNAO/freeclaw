/**
 * Heartbeat session compaction (docs/design/heartbeat-compaction.md §2).
 *
 * Before a heartbeat turn, compact the heartbeat session when its context is above the
 * threshold (§3), on the session's own model (§2.2, never heartbeat.model), only when the
 * session is idle and the gateway is not draining. Quiet: one log line, nothing sent to any chat.
 */
import crypto from "node:crypto";
import path from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  isCliProvider,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import {
  compactEmbeddedPiSession,
  isEmbeddedPiRunActive,
  resolveEmbeddedSessionLane,
  runEmbeddedPiAgent,
} from "../agents/pi-embedded.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../agents/sandbox.js";
import { applySessionContextLimitToTokens } from "../agents/session-context-limit.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { readPromptTokensFromSessionLog } from "../auto-reply/reply/agent-runner-memory.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushRelativePathForRun,
  resolveMemoryFlushSettings,
} from "../auto-reply/reply/memory-flush.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { resolveThreadParentSessionKey } from "../sessions/session-key-utils.js";
import { formatErrorMessage } from "./errors.js";
import { resolveHeartbeatCompactionThreshold } from "./heartbeat-compaction-threshold.js";
import { isGatewayDraining } from "./session-stack.js";

const log = createSubsystemLogger("gateway/heartbeat");

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

export type SessionCompactionModel = { provider: string; model: string };

export type HeartbeatCompactionOutcome =
  | { status: "skipped"; reason: HeartbeatCompactionSkipReason }
  | { status: "compacted"; tokensBefore: number; tokensAfter?: number }
  | { status: "not-compacted"; reason?: string }
  | { status: "nothing-to-compact"; tokens: number }
  | { status: "failed"; error: string };

export type HeartbeatCompactionSkipReason =
  | "off"
  | "no-session"
  | "unknown-size"
  | "under-threshold"
  | "active-run"
  | "draining"
  | "nothing-to-compact";

/**
 * §2.7: after a nothing-to-compact outcome, no new attempt until the session has grown past the
 * recorded count by at least this share of the threshold.
 */
export const HEARTBEAT_NOTHING_TO_COMPACT_REGROWTH_SHARE = 0.2;

/**
 * §2.7: true while the recorded nothing-to-compact outcome still applies: same session, no
 * compaction since, and the session has not grown past the recorded count by 20 % of the threshold.
 */
export function isHeartbeatNothingToCompactPending(params: {
  entry: SessionEntry;
  tokens: number;
  threshold: number;
}): boolean {
  const record = params.entry.heartbeatNothingToCompact;
  if (!record || typeof record.tokens !== "number" || !Number.isFinite(record.tokens)) {
    return false;
  }
  if (record.sessionId !== params.entry.sessionId) {
    return false;
  }
  if (record.compactionCount !== (params.entry.compactionCount ?? 0)) {
    return false;
  }
  const regrowth = params.threshold * HEARTBEAT_NOTHING_TO_COMPACT_REGROWTH_SHARE;
  return params.tokens < record.tokens + regrowth;
}

/**
 * §2.2: the session's own model, i.e. the model a normal message to that session would run on:
 * the session's stored model override (or its parent's), else the channel model override, else
 * the agent default. A stored override outside the model allowlist falls through to the channel
 * override, then the agent default.
 *
 * This is the ONE resolver for the heartbeat compaction model, its threshold window (§3) and the
 * `openclaw status` line. It deliberately takes no heartbeat config: heartbeat.model (and any other
 * per-turn or per-job model) only picks the model of the heartbeat turn, never the compaction model.
 */
export function resolveSessionCompactionModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry?: SessionEntry;
  store?: Record<string, SessionEntry | undefined>;
}): SessionCompactionModel {
  const { cfg, agentId, entry } = params;
  const defaults = resolveDefaultModelForAgent({ cfg, agentId });
  const defaultProvider = defaults.provider;

  const stored = resolveStoredOverride(entry, params.store, params.sessionKey);
  if (stored) {
    const provider = stored.provider || defaultProvider;
    const allowlist = cfg.agents?.defaults?.models ?? {};
    const allowed =
      Object.keys(allowlist).length === 0 ||
      buildAllowedModelSet({
        cfg,
        catalog: [],
        defaultProvider,
        defaultModel: defaults.model,
        agentId,
      }).allowedKeys.has(modelKey(provider, stored.model));
    if (allowed) {
      return { provider, model: stored.model };
    }
  }

  const channelOverride = resolveChannelModelOverride({
    cfg,
    channel: entry?.channel ?? entry?.origin?.provider ?? entry?.lastChannel,
    groupId: entry?.groupId,
    groupChannel: entry?.groupChannel,
    groupSubject: entry?.subject,
    // A thread session inherits its parent group's channel override, like a normal message.
    parentSessionKey: resolveThreadParentSessionKey(params.sessionKey),
  });
  if (channelOverride) {
    const resolved = resolveModelRefFromString({
      raw: channelOverride.model,
      defaultProvider,
      aliasIndex: buildModelAliasIndex({ cfg, defaultProvider }),
    });
    if (resolved) {
      return { provider: resolved.ref.provider, model: resolved.ref.model };
    }
  }

  return { provider: defaults.provider, model: defaults.model };
}

function resolveStoredOverride(
  entry: SessionEntry | undefined,
  store: Record<string, SessionEntry | undefined> | undefined,
  sessionKey: string,
): { provider?: string; model: string } | null {
  const direct = entry?.modelOverride?.trim();
  if (direct) {
    return { provider: entry?.providerOverride?.trim() || undefined, model: direct };
  }
  const parentKey = resolveThreadParentSessionKey(sessionKey);
  const parent = parentKey && parentKey !== sessionKey ? store?.[parentKey] : undefined;
  const parentModel = parent?.modelOverride?.trim();
  if (parentModel) {
    return { provider: parent?.providerOverride?.trim() || undefined, model: parentModel };
  }
  return null;
}

/** W: the max context window of the given model (capped by agents.defaults.contextTokens). */
export function resolveHeartbeatContextWindow(params: {
  cfg: OpenClawConfig;
  model: SessionCompactionModel;
  entry?: SessionEntry;
}): number {
  const { cfg, model, entry } = params;
  const sameRuntimeModel =
    entry?.model?.trim() === model.model &&
    (!entry?.modelProvider || entry.modelProvider.trim() === model.provider);
  const recorded =
    sameRuntimeModel && typeof entry?.contextTokens === "number" && entry.contextTokens > 0
      ? entry.contextTokens
      : undefined;
  const window =
    resolveContextTokensForModel({
      cfg,
      provider: model.provider,
      model: model.model,
    }) ??
    recorded ??
    DEFAULT_CONTEXT_TOKENS;
  const cap = cfg.agents?.defaults?.contextTokens;
  const capped = typeof cap === "number" && cap > 0 && cap < window ? cap : window;
  // Session context limit ARCH §1.2: the session's own limit can only lower W further.
  return applySessionContextLimitToTokens(capped, entry?.contextLimit);
}

/** The heartbeat session's current context size in tokens, if known. */
export async function readHeartbeatSessionTokens(params: {
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<number | undefined> {
  const fresh = resolveFreshSessionTotalTokens(params.entry);
  if (typeof fresh === "number" && fresh > 0) {
    return fresh;
  }
  try {
    const usage = await readPromptTokensFromSessionLog(
      params.entry.sessionId,
      params.entry,
      params.sessionKey,
      { storePath: params.storePath },
    );
    const prompt = usage?.promptTokens;
    if (typeof prompt === "number" && Number.isFinite(prompt) && prompt > 0) {
      return prompt + (usage?.outputTokens ?? 0);
    }
  } catch {
    // Unknown size: skip this time.
  }
  return undefined;
}

function isSessionBusy(entry: SessionEntry, sessionKey: string): boolean {
  if (isEmbeddedPiRunActive(entry.sessionId)) {
    return true;
  }
  const lanes = new Set([
    resolveEmbeddedSessionLane(sessionKey),
    resolveEmbeddedSessionLane(entry.sessionId),
  ]);
  for (const lane of lanes) {
    if (getQueueSize(lane) > 0) {
      return true;
    }
  }
  return false;
}

function resolveThinkLevel(
  cfg: OpenClawConfig,
  entry: SessionEntry,
  model: SessionCompactionModel,
) {
  return (
    normalizeThinkLevel(entry.thinkingLevel) ??
    resolveThinkingDefault({ cfg, provider: model.provider, model: model.model })
  );
}

function canRunMemoryFlush(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  provider: string;
  entry: SessionEntry;
}): boolean {
  if (isCliProvider(params.provider, params.cfg)) {
    return false;
  }
  if (hasAlreadyFlushedForCurrentCompaction(params.entry)) {
    return false;
  }
  const runtime = resolveSandboxRuntimeStatus({ cfg: params.cfg, sessionKey: params.sessionKey });
  if (!runtime.sandboxed) {
    return true;
  }
  return resolveSandboxConfigForAgent(params.cfg, runtime.agentId).workspaceAccess === "rw";
}

/**
 * Pre-compaction memory flush on the heartbeat session (same model, nothing delivered).
 * Errors are logged and never block compaction.
 */
async function runHeartbeatMemoryFlush(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
  sessionFile: string;
  workspaceDir: string;
  agentDir: string;
  model: SessionCompactionModel;
  thinkLevel: ReturnType<typeof resolveThinkLevel>;
}): Promise<void> {
  const settings = resolveMemoryFlushSettings(params.cfg);
  if (!settings) {
    return;
  }
  if (
    !canRunMemoryFlush({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      provider: params.model.provider,
      entry: params.entry,
    })
  ) {
    return;
  }
  const nowMs = Date.now();
  try {
    await runEmbeddedPiAgent({
      sessionId: params.entry.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      trigger: "memory",
      memoryFlushWritePath: resolveMemoryFlushRelativePathForRun({ cfg: params.cfg, nowMs }),
      prompt: resolveMemoryFlushPromptForRun({ prompt: settings.prompt, cfg: params.cfg, nowMs }),
      extraSystemPrompt: settings.systemPrompt,
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.cfg,
      skillsSnapshot: params.entry.skillsSnapshot,
      provider: params.model.provider,
      model: params.model.model,
      thinkLevel: params.thinkLevel,
      disableMessageTool: true,
      bootstrapContextRunKind: "heartbeat",
      timeoutMs: resolveAgentTimeoutMs({ cfg: params.cfg, provider: params.model.provider }),
      runId: crypto.randomUUID(),
    });
    await updateSessionStore(params.storePath, (store) => {
      const current = store[params.sessionKey];
      if (!current) {
        return;
      }
      store[params.sessionKey] = {
        ...current,
        memoryFlushAt: Date.now(),
        memoryFlushCompactionCount: current.compactionCount ?? 0,
      };
    });
  } catch (err) {
    log.warn(`heartbeat: memory flush before compaction failed: ${formatErrorMessage(err)}`, {
      sessionKey: params.sessionKey,
    });
  }
}

/**
 * §2.1: compact the heartbeat session before the heartbeat turn when it is above the
 * threshold. Never throws; failures are logged and retried at the next heartbeat.
 */
export async function maybeCompactHeartbeatSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  sessionKey: string;
  storePath: string;
}): Promise<HeartbeatCompactionOutcome> {
  const { cfg, agentId, heartbeat, sessionKey, storePath } = params;
  try {
    const compactAt = heartbeat?.compactAt;
    if (compactAt === "off") {
      return { status: "skipped", reason: "off" };
    }
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    if (!entry?.sessionId) {
      return { status: "skipped", reason: "no-session" };
    }
    const model = resolveSessionCompactionModel({
      cfg,
      agentId,
      sessionKey,
      entry,
      store,
    });
    const threshold = resolveHeartbeatCompactionThreshold({
      contextWindowTokens: resolveHeartbeatContextWindow({ cfg, model, entry }),
      compactAt,
    });
    if (threshold === null) {
      return { status: "skipped", reason: "off" };
    }
    const tokens = await readHeartbeatSessionTokens({ entry, sessionKey, storePath });
    if (tokens === undefined) {
      return { status: "skipped", reason: "unknown-size" };
    }
    if (tokens <= threshold) {
      return { status: "skipped", reason: "under-threshold" };
    }
    if (isGatewayDraining()) {
      return { status: "skipped", reason: "draining" };
    }
    if (isSessionBusy(entry, sessionKey)) {
      return { status: "skipped", reason: "active-run" };
    }
    // §2.7: nothing to compact at about this size last time: no memory flush, no compaction.
    if (isHeartbeatNothingToCompactPending({ entry, tokens, threshold })) {
      return { status: "skipped", reason: "nothing-to-compact" };
    }

    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionFile = resolveSessionFilePath(entry.sessionId, entry, {
      agentId,
      sessionsDir: path.dirname(storePath),
    });
    const thinkLevel = resolveThinkLevel(cfg, entry, model);

    await runHeartbeatMemoryFlush({
      cfg,
      agentId,
      sessionKey,
      storePath,
      entry,
      sessionFile,
      workspaceDir,
      agentDir,
      model,
      thinkLevel,
    });

    const customInstructions = heartbeat?.compactInstructions?.trim() || undefined;
    const result = await compactEmbeddedPiSession({
      sessionId: entry.sessionId,
      sessionKey,
      messageChannel: entry.lastChannel,
      groupId: entry.groupId,
      groupChannel: entry.groupChannel,
      groupSpace: entry.space,
      spawnedBy: entry.spawnedBy,
      sessionFile,
      workspaceDir,
      agentDir,
      config: cfg,
      skillsSnapshot: entry.skillsSnapshot,
      provider: model.provider,
      model: model.model,
      thinkLevel,
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      customInstructions,
      currentTokenCount: tokens,
      trigger: "heartbeat",
    });

    if (result.ok && !result.compacted && result.nothingToCompact) {
      // §2.7: an outcome, not a failure. Logged once; the record holds further attempts back.
      await recordHeartbeatNothingToCompact({ storePath, sessionKey, entry, tokens });
      log.info(
        `heartbeat: nothing to compact at ${tokens} tokens (threshold ${threshold}); ` +
          `next attempt after growth to ${Math.ceil(tokens + threshold * HEARTBEAT_NOTHING_TO_COMPACT_REGROWTH_SHARE)} tokens`,
        { sessionKey, tokens, threshold },
      );
      return { status: "nothing-to-compact", tokens };
    }
    if (!result.ok) {
      const error = result.reason?.trim() || "unknown error";
      log.warn(`heartbeat: compaction failed (will retry next heartbeat): ${error}`, {
        sessionKey,
      });
      return { status: "failed", error };
    }
    if (!result.compacted) {
      log.debug(`heartbeat: compaction skipped: ${result.reason ?? "nothing to compact"}`, {
        sessionKey,
      });
      return { status: "not-compacted", reason: result.reason };
    }

    const tokensAfter = result.result?.tokensAfter;
    await recordHeartbeatCompaction({ storePath, sessionKey, tokensAfter });
    log.info(
      `heartbeat: compacted session ${tokens} → ${tokensAfter ?? "?"} tokens ` +
        `(threshold ${threshold}, model ${model.provider}/${model.model})`,
      { sessionKey, tokensBefore: tokens, tokensAfter: tokensAfter ?? null, threshold },
    );
    return { status: "compacted", tokensBefore: tokens, tokensAfter };
  } catch (err) {
    const error = formatErrorMessage(err);
    log.warn(`heartbeat: compaction failed (will retry next heartbeat): ${error}`, { sessionKey });
    return { status: "failed", error };
  }
}

/** Persist the compaction without touching updatedAt (heartbeats are not activity). */
async function recordHeartbeatCompaction(params: {
  storePath: string;
  sessionKey: string;
  tokensAfter?: number;
}): Promise<void> {
  const now = Date.now();
  await updateSessionStore(params.storePath, (store) => {
    const current = store[params.sessionKey];
    if (!current) {
      return;
    }
    // §2.7: a successful compaction clears the nothing-to-compact record.
    const { heartbeatNothingToCompact: _cleared, ...rest } = current;
    const next: SessionEntry = {
      ...rest,
      compactionCount: (current.compactionCount ?? 0) + 1,
      heartbeatCompactedAt: now,
    };
    if (typeof params.tokensAfter === "number" && params.tokensAfter > 0) {
      next.totalTokens = params.tokensAfter;
      next.totalTokensFresh = true;
      next.inputTokens = undefined;
      next.outputTokens = undefined;
      next.cacheRead = undefined;
      next.cacheWrite = undefined;
    }
    store[params.sessionKey] = next;
  });
}

/** §2.7: record the size at which compaction found nothing to summarize (updatedAt untouched). */
async function recordHeartbeatNothingToCompact(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
  tokens: number;
}): Promise<void> {
  await updateSessionStore(params.storePath, (store) => {
    const current = store[params.sessionKey];
    if (!current || current.sessionId !== params.entry.sessionId) {
      return;
    }
    store[params.sessionKey] = {
      ...current,
      heartbeatNothingToCompact: {
        tokens: params.tokens,
        at: Date.now(),
        sessionId: current.sessionId,
        compactionCount: current.compactionCount ?? 0,
      },
    };
  });
}

export type HeartbeatCompactionStatus = {
  sessionKey: string;
  /** Current context size of the heartbeat session, when known. */
  totalTokens: number | null;
  /** Compaction threshold in tokens; null when heartbeat compaction is off. */
  threshold: number | null;
  /** Epoch ms of the last heartbeat compaction, if any. */
  lastCompactedAt: number | null;
};

/** §2.5: size, threshold and last compaction time for `openclaw status`. */
export function resolveHeartbeatCompactionStatus(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  sessionKey: string;
  store: Record<string, SessionEntry | undefined>;
}): HeartbeatCompactionStatus {
  const { cfg, agentId, heartbeat, sessionKey, store } = params;
  const entry = store[sessionKey];
  const model = resolveSessionCompactionModel({
    cfg,
    agentId,
    sessionKey,
    entry,
    store,
  });
  const threshold = resolveHeartbeatCompactionThreshold({
    contextWindowTokens: resolveHeartbeatContextWindow({ cfg, model, entry }),
    compactAt: heartbeat?.compactAt,
  });
  const totalTokens = resolveFreshSessionTotalTokens(entry);
  return {
    sessionKey,
    totalTokens: totalTokens ?? null,
    threshold,
    lastCompactedAt:
      typeof entry?.heartbeatCompactedAt === "number" ? entry.heartbeatCompactedAt : null,
  };
}
