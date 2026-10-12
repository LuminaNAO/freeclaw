import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveSessionAgentId } from "./agent-scope.js";

/**
 * Per-group memory, implemented after the group-memory ARCH
 * (docs/design/group-memory.md, operator-owned; do not edit that file).
 *
 * Layout (ARCH §1): <workspace>/group-memory/<channel>/<url-encoded group id>/
 *   - meta.json   maintained by the gateway (§3), never by the model
 *   - CONTEXT.md  durable context written by the agent (§4)
 *   - history.md  append-only dated one-liners written by the agent
 * Directory 0700, files 0600 (same sensitivity as transcripts).
 */

export const GROUP_MEMORY_DIR_NAME = "group-memory";
export const GROUP_MEMORY_META_FILENAME = "meta.json";
export const GROUP_MEMORY_CONTEXT_FILENAME = "CONTEXT.md";
export const GROUP_MEMORY_HISTORY_FILENAME = "history.md";

export const GROUP_MEMORY_DEFAULTS = {
  enabled: true,
  historyLines: 20,
  maxContextBytes: 16_384,
} as const;

const GROUP_MEMORY_META_WRITE_THROTTLE_MS = 60_000;

export type GroupMemoryConfig = {
  /** Master switch (default true). Disabling stops both loading and meta writes; files stay (§5). */
  enabled?: boolean;
  /** How many trailing history.md lines enter the prompt block (default 20). */
  historyLines?: number;
  /** CONTEXT.md is truncated in the prompt beyond this many bytes, with a note (default 16384). */
  maxContextBytes?: number;
};

export type ResolvedGroupMemoryConfig = {
  enabled: boolean;
  historyLines: number;
  maxContextBytes: number;
};

/** §5: agents.defaults.groupMemory with a per-agent override under agents.list[].groupMemory. */
export function resolveGroupMemoryConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): ResolvedGroupMemoryConfig {
  const cfg = params.cfg;
  const defaults = cfg?.agents?.defaults?.groupMemory;
  const agentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: cfg })
    : params.agentId;
  const entry =
    agentId && cfg
      ? (cfg.agents?.list ?? []).find(
          (candidate) =>
            typeof candidate?.id === "string" &&
            normalizeAgentId(candidate.id) === normalizeAgentId(agentId),
        )
      : undefined;
  const override = entry?.groupMemory;
  const pick = <T>(value: T | undefined, fallback: T | undefined, dflt: T): T =>
    value !== undefined ? value : fallback !== undefined ? fallback : dflt;
  return {
    enabled: pick(override?.enabled, defaults?.enabled, GROUP_MEMORY_DEFAULTS.enabled),
    historyLines: pick(
      override?.historyLines,
      defaults?.historyLines,
      GROUP_MEMORY_DEFAULTS.historyLines,
    ),
    maxContextBytes: pick(
      override?.maxContextBytes,
      defaults?.maxContextBytes,
      GROUP_MEMORY_DEFAULTS.maxContextBytes,
    ),
  };
}

export function isGroupMemoryEnabled(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): boolean {
  return resolveGroupMemoryConfig(params).enabled;
}

/** §1: folder names use encodeURIComponent(groupId). */
export function encodeGroupMemoryId(groupId: string): string {
  return encodeURIComponent(groupId);
}

export function resolveGroupMemoryDir(params: {
  workspaceDir: string;
  channel: string;
  groupId: string;
}): string {
  const channel = params.channel.trim().toLowerCase();
  return path.join(
    params.workspaceDir,
    GROUP_MEMORY_DIR_NAME,
    channel,
    encodeGroupMemoryId(params.groupId),
  );
}

export type GroupMemoryMeta = {
  channel: string;
  groupId: string;
  name: string;
  description?: string;
  members: string[];
  firstSeen: string;
  lastSeen: string;
  /** §6: an existing context_file key pointing elsewhere in the workspace is honoured. */
  context_file?: string;
  /** §6: unknown keys in an existing meta.json are preserved on update. */
  [key: string]: unknown;
};

function readJsonFile(file: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function readGroupMemoryMeta(dir: string): GroupMemoryMeta | undefined {
  const parsed = readJsonFile(path.join(dir, GROUP_MEMORY_META_FILENAME));
  if (!parsed) {
    return undefined;
  }
  return parsed as GroupMemoryMeta;
}

function ensureDir0700(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort; creation mode is the guarantee on a fresh dir
  }
}

function writeFile0600(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

// In-process throttle memory: at most one meta.json write per group per minute (§3).
const lastMetaWriteAtByDir = new Map<string, number>();
/**
 * Members seen while throttled, merged into meta.json on the next write so a
 * throttled tick defers a new member instead of silently losing them.
 */
const pendingMembersByDir = new Map<string, Set<string>>();

/** @internal Test hook: reset the §3 throttle state. */
export function resetGroupMemoryMetaThrottleForTests(): void {
  lastMetaWriteAtByDir.clear();
  pendingMembersByDir.clear();
}

/**
 * §3 gateway-maintained meta: create on first sight (name from the channel's
 * group subject when known), refresh lastSeen, add new sender ids to members.
 * Throttled to at most one write per group per minute. Unknown keys preserved (§6).
 */
export function updateGroupMemoryMetaOnInbound(params: {
  workspaceDir: string;
  channel: string;
  groupId: string;
  /** Group subject/name when the channel adapter knows it. */
  groupName?: string;
  /** Sender id of the inbound message, added to members when new. */
  senderId?: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  now?: number;
}): { dir: string; written: boolean; reason?: "disabled" | "throttled" } {
  const now = params.now ?? Date.now();
  const enabled = isGroupMemoryEnabled({ cfg: params.cfg, agentId: params.agentId });
  const dir = resolveGroupMemoryDir({
    workspaceDir: params.workspaceDir,
    channel: params.channel,
    groupId: params.groupId,
  });
  if (!enabled) {
    return { dir, written: false, reason: "disabled" };
  }
  const metaPath = path.join(dir, GROUP_MEMORY_META_FILENAME);
  const existing = readGroupMemoryMeta(dir);
  const senderId = params.senderId?.trim();
  const groupName = params.groupName?.trim();
  const members = new Set(
    Array.isArray(existing?.members)
      ? existing.members.filter((m): m is string => typeof m === "string")
      : [],
  );
  const persistedOrDeferredHasSender = (id: string) =>
    members.has(id) || (pendingMembersByDir.get(dir)?.has(id) ?? false);
  const hadSender = senderId ? persistedOrDeferredHasSender(senderId) : true;
  if (senderId) {
    members.add(senderId);
  }

  if (!existing) {
    const meta: GroupMemoryMeta = {
      channel: params.channel.trim().toLowerCase(),
      groupId: params.groupId,
      name: groupName || params.groupId,
      members: [...members],
      firstSeen: new Date(now).toISOString(),
      lastSeen: new Date(now).toISOString(),
    };
    ensureDir0700(dir);
    writeFile0600(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    lastMetaWriteAtByDir.set(dir, now);
    return { dir, written: true };
  }

  const nothingToWrite = !groupName && (hadSender || !senderId) && !pendingMembersByDir.has(dir);
  const lastWrite = lastMetaWriteAtByDir.get(dir) ?? 0;
  if (now - lastWrite < GROUP_MEMORY_META_WRITE_THROTTLE_MS) {
    // Defer, don't drop: remember a new sender so the next write merges them.
    if (senderId && !hadSender) {
      const pending = pendingMembersByDir.get(dir) ?? new Set<string>();
      pending.add(senderId);
      pendingMembersByDir.set(dir, pending);
    }
    return { dir, written: false, reason: "throttled" };
  }
  if (nothingToWrite) {
    // Still refresh lastSeen, but respect the throttle: skip the write entirely.
    return { dir, written: false, reason: "throttled" };
  }
  // Merge any members deferred while throttled into this write.
  for (const pending of pendingMembersByDir.get(dir) ?? []) {
    members.add(pending);
  }

  const next: GroupMemoryMeta = {
    ...existing,
    channel:
      typeof existing.channel === "string" && existing.channel
        ? existing.channel
        : params.channel.trim().toLowerCase(),
    groupId:
      typeof existing.groupId === "string" && existing.groupId ? existing.groupId : params.groupId,
    name: groupName || (typeof existing.name === "string" && existing.name) || params.groupId,
    members: [...members],
    firstSeen:
      typeof existing.firstSeen === "string" && existing.firstSeen
        ? existing.firstSeen
        : new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(),
  };
  ensureDir0700(dir);
  writeFile0600(metaPath, `${JSON.stringify(next, null, 2)}\n`);
  lastMetaWriteAtByDir.set(dir, now);
  pendingMembersByDir.delete(dir);
  return { dir, written: true };
}

function resolveContextFilePath(dir: string, meta: GroupMemoryMeta | undefined): string {
  // §6: an existing context_file key pointing elsewhere in the workspace is honoured.
  const override = typeof meta?.context_file === "string" ? meta.context_file.trim() : "";
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(dir, override);
  }
  return path.join(dir, GROUP_MEMORY_CONTEXT_FILENAME);
}

function readTextFileIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/**
 * §2: build the "## Group memory" block for a group session from the files on
 * disk (cheap reads, no cache, so edits are picked up on the next turn and the
 * block survives compaction and /new).
 *
 * Returns undefined for non-group sessions and when group memory is disabled:
 * group memory is NEVER loaded into another group's session or into a DM/main
 * session (§2 isolation).
 */
export function buildGroupMemoryPromptBlock(params: {
  workspaceDir: string;
  /** Session key; the block is only built when this is a group/channel session. */
  sessionKey?: string;
  channel?: string;
  groupId?: string;
  cfg?: OpenClawConfig;
  agentId?: string;
}): string | undefined {
  const channel = params.channel?.trim().toLowerCase();
  const groupId = params.groupId?.trim();
  if (!channel || !groupId) {
    return undefined;
  }
  const config = resolveGroupMemoryConfig({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (!config.enabled) {
    return undefined;
  }
  const dir = resolveGroupMemoryDir({
    workspaceDir: params.workspaceDir,
    channel,
    groupId,
  });
  const meta = readGroupMemoryMeta(dir);
  const contextRaw = readTextFileIfPresent(resolveContextFilePath(dir, meta));
  const historyRaw = readTextFileIfPresent(path.join(dir, GROUP_MEMORY_HISTORY_FILENAME));

  const lines: string[] = ["## Group memory", `Folder: ${dir}`];
  const memberCount = Array.isArray(meta?.members) ? meta.members.length : 0;
  const name = typeof meta?.name === "string" && meta.name.trim() ? meta.name.trim() : undefined;
  if (meta) {
    lines.push(`Group: ${name ?? groupId} (${memberCount} member${memberCount === 1 ? "" : "s"})`);
  }

  let hasContent = false;
  if (contextRaw !== undefined) {
    const { text, truncated } = truncateBytes(contextRaw.trim(), config.maxContextBytes);
    if (text) {
      lines.push("", text);
      if (truncated) {
        lines.push(
          "",
          `[CONTEXT.md truncated at ${config.maxContextBytes} bytes (agents.defaults.groupMemory.maxContextBytes); shorten it.]`,
        );
      }
      hasContent = true;
    }
  }
  if (historyRaw !== undefined) {
    const historyLines = historyRaw
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    const tail = historyLines.slice(-Math.max(0, config.historyLines));
    if (tail.length > 0) {
      lines.push("", "### Recent history", ...tail);
      hasContent = true;
    }
  }
  if (!hasContent) {
    lines.push("", "No group memory yet — create CONTEXT.md when the group's purpose is clear.");
  }
  lines.push("");
  return lines.join("\n");
}
