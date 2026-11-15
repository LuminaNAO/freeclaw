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
/**
 * Legacy member ids awaiting conversion (old id -> current id), deferred while
 * throttled the same way new members are (Signal uuid ARCH §3.3).
 */
const pendingRenamesByDir = new Map<string, Map<string, string>>();

/** @internal Test hook: reset the §3 throttle state. */
export function resetGroupMemoryMetaThrottleForTests(): void {
  lastMetaWriteAtByDir.clear();
  pendingMembersByDir.clear();
  pendingRenamesByDir.clear();
  resetLegacyGroupMemoryMigrationForTests();
}

/**
 * Legacy group-memory layout (pre-v25 agent protocol, 2026-11-15 incident):
 *   group-memory/<channel>/<encodeURIComponent(rawId)>   // no kind prefix, original case
 * The gateway convention (§1) is:
 *   group-memory/<channel>/<encodeURIComponent("group:" + rawId.toLowerCase())>
 *
 * The id is lowercased on the way into the session key, so the legacy folder name
 * is NOT derivable from the canonical id (its original case is lost). Recovery is
 * therefore a bounded directory scan, memoized per canonical dir. The scan matches
 * case-insensitively on the encoded raw id and falls back to the legacy meta's
 * `signal_id`/`groupId` field.
 */
const legacyGroupMemoryMigrated = new Map<string, string | undefined>();

/** @internal Test hook: reset the legacy-migration memo. */
export function resetLegacyGroupMemoryMigrationForTests(): void {
  legacyGroupMemoryMigrated.clear();
}

function legacyMetaIdentity(meta: GroupMemoryMeta | undefined): string | undefined {
  if (!meta) {
    return undefined;
  }
  const direct = typeof meta.groupId === "string" ? meta.groupId : undefined;
  if (direct) {
    return direct;
  }
  const signalId = (meta as Record<string, unknown>)["signal_id"];
  return typeof signalId === "string" ? signalId : undefined;
}

/** Find a legacy-layout folder for this group's canonical dir. Memoized. */
function findLegacyGroupDir(params: {
  workspaceDir: string;
  channel: string;
  groupId: string;
  canonicalDir: string;
}): string | undefined {
  if (legacyGroupMemoryMigrated.has(params.canonicalDir)) {
    return legacyGroupMemoryMigrated.get(params.canonicalDir);
  }
  const channelDir = path.dirname(params.canonicalDir);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(channelDir);
  } catch {
    legacyGroupMemoryMigrated.set(params.canonicalDir, undefined);
    return undefined;
  }
  // Canonical groupId is `group:<rawLower>` (or `channel:<rawLower>`). The legacy
  // folder name is `encodeURIComponent(rawId)` — WITHOUT the kind prefix — in the
  // original case. So strip the prefix to recover the raw id for matching.
  const colonIdx = params.groupId.indexOf(":");
  const rawLower = (
    colonIdx >= 0 ? params.groupId.slice(colonIdx + 1) : params.groupId
  ).toLowerCase();
  const legacyLower = encodeURIComponent(rawLower).toLowerCase();
  let found: string | undefined;
  for (const entry of entries) {
    if (
      entry.startsWith(".") ||
      entry.startsWith("group%3A") ||
      entry.startsWith("channel%3A") ||
      entry === GROUP_MEMORY_META_FILENAME
    ) {
      continue;
    }
    const dir = path.join(channelDir, entry);
    // Never treat the canonical dir as its own legacy twin.
    if (dir === params.canonicalDir) {
      continue;
    }
    // A memoized path that has since been archived is no longer a twin.
    try {
      if (!fs.existsSync(dir)) {
        continue;
      }
    } catch {
      continue;
    }
    try {
      if (!fs.statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    // Fast match: encoded raw id, case-insensitive (legacy kept original case).
    if (entry.toLowerCase() === legacyLower) {
      found = dir;
      break;
    }
    // Slow match: identity recorded in the legacy meta.json.
    const meta = readGroupMemoryMeta(dir);
    const identity = legacyMetaIdentity(meta)?.trim().toLowerCase();
    if (identity && (identity === `group:${rawLower}` || identity === rawLower)) {
      found = dir;
      break;
    }
  }
  legacyGroupMemoryMigrated.set(params.canonicalDir, found);
  return found;
}

function canonicalMemberKey(id: string): string {
  return id.startsWith("uuid:") ? id.slice(5) : id;
}

/**
 * Migrate a legacy-layout folder into the canonical §1 layout: copy CONTEXT.md /
 * history.md (never overwriting existing canonical files), build a gateway-schema
 * meta.json when absent (merging members and firstSeen otherwise), then archive the
 * legacy dir under `<channel>/.archive/` so it is not re-scanned or re-read.
 * Best-effort: failures leave both layouts in place (recovery, not destruction).
 */
function migrateLegacyGroupDir(params: {
  legacyDir: string;
  canonicalDir: string;
  channel: string;
  groupId: string;
}): boolean {
  const { legacyDir, canonicalDir, channel, groupId } = params;
  const now = new Date().toISOString();
  const legacyMeta = readGroupMemoryMeta(legacyDir) as
    | (GroupMemoryMeta & Record<string, unknown>)
    | undefined;

  ensureDir0700(canonicalDir);
  for (const file of [GROUP_MEMORY_CONTEXT_FILENAME, GROUP_MEMORY_HISTORY_FILENAME]) {
    const src = path.join(legacyDir, file);
    const dst = path.join(canonicalDir, file);
    try {
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o600);
      }
    } catch {
      // best effort per file
    }
  }

  const canonicalMetaPath = path.join(canonicalDir, GROUP_MEMORY_META_FILENAME);
  const canonicalMeta = readGroupMemoryMeta(canonicalDir);
  const legacyExtra = legacyMeta ?? ({} as Record<string, unknown>);
  if (!canonicalMeta) {
    const legacyMembers = Array.isArray(legacyMeta?.members)
      ? legacyMeta.members.filter((m): m is string => typeof m === "string")
      : [];
    const meta: GroupMemoryMeta = {
      channel,
      groupId,
      name: (typeof legacyMeta?.name === "string" && legacyMeta.name.trim()) || groupId,
      members: legacyMembers,
      firstSeen:
        (typeof legacyMeta?.firstSeen === "string" && legacyMeta.firstSeen) ||
        (typeof legacyExtra["first_seen_at"] === "string" ? legacyExtra["first_seen_at"] : now),
      lastSeen: now,
    };
    const contextFile = legacyExtra["context_file"];
    if (typeof contextFile === "string") {
      meta.context_file = contextFile;
    }
    try {
      writeFile0600(canonicalMetaPath, `${JSON.stringify(meta, null, 2)}\n`);
    } catch {
      return false;
    }
  } else {
    const merged = new Map<string, string>();
    for (const id of [...canonicalMeta.members, ...(legacyMeta?.members ?? [])]) {
      if (typeof id === "string" && id.trim()) {
        const key = canonicalMemberKey(id);
        if (!merged.has(key)) {
          merged.set(key, id);
        }
      }
    }
    const firstSeenCandidates = [
      canonicalMeta.firstSeen,
      legacyMeta?.firstSeen,
      typeof legacyExtra["first_seen_at"] === "string" ? legacyExtra["first_seen_at"] : undefined,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    const next: GroupMemoryMeta = {
      ...canonicalMeta,
      members: [...merged.values()],
      firstSeen: firstSeenCandidates.toSorted()[0] ?? canonicalMeta.firstSeen,
    };
    writeFile0600(canonicalMetaPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  const archiveDir = path.join(path.dirname(canonicalDir), ".archive");
  try {
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    let dest = path.join(archiveDir, path.basename(legacyDir));
    for (let n = 1; fs.existsSync(dest); n += 1) {
      dest = `${dest}.${n}`;
    }
    fs.renameSync(legacyDir, dest);
  } catch {
    // Best effort: if the archive move fails, the memo still prevents re-scanning
    // this canonical dir in this process, and the canonical layout is complete.
  }
  return true;
}

/**
 * If a legacy-layout folder exists for this group, migrate it into the canonical
 * layout — whether or not the canonical meta already exists (create it when absent,
 * merge members/files when present). Returns the (possibly new/merged) meta.
 * Returns the existing meta untouched when there is no legacy twin to recover.
 */
function healLegacyGroupMemory(params: {
  workspaceDir: string;
  channel: string;
  groupId: string;
  canonicalDir: string;
  existing: GroupMemoryMeta | undefined;
}): GroupMemoryMeta | undefined {
  const legacyDir = findLegacyGroupDir(params);
  if (!legacyDir) {
    return params.existing;
  }
  migrateLegacyGroupDir({
    legacyDir,
    canonicalDir: params.canonicalDir,
    channel: params.channel,
    groupId: params.groupId,
  });
  return readGroupMemoryMeta(params.canonicalDir) ?? params.existing;
}

/**
 * group-memory ARCH §8.1: what a meta.json write means for the `group_memory_created`
 * hook. "created" on first creation, "renamed" when an existing group's name changes;
 * ordinary updates carry no event. Name and path only, never chat content or members.
 */
export type GroupMemoryEvent = {
  reason: "created" | "renamed";
  channel: string;
  groupId: string;
  name: string;
  dir: string;
  firstSeen: string;
};

/** §8.2: the starter CONTEXT.md, written on creation when none exists. */
export const GROUP_MEMORY_STARTER_PURPOSE =
  "Purpose: (not yet known — learn it from the conversation)";

export function starterGroupContext(name: string): string {
  const title = name.replace(/[\r\n]+/g, " ").trim();
  return `# ${title}\n\n${GROUP_MEMORY_STARTER_PURPOSE}\n`;
}

/**
 * §8.2: seed CONTEXT.md only when absent. The exclusive create flag means an existing
 * file (the agent's, or an operator's from the §6 convention) is never overwritten.
 */
function seedGroupContextFile(dir: string, name: string): boolean {
  const file = path.join(dir, GROUP_MEMORY_CONTEXT_FILENAME);
  try {
    fs.writeFileSync(file, starterGroupContext(name), { mode: 0o600, flag: "wx" });
  } catch {
    return false;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
  return true;
}

/** Replace legacy member ids with their current id, keeping order and dropping duplicates. */
function applyMemberRenames(members: Set<string>, renames: Map<string, string>): Set<string> {
  if (renames.size === 0) {
    return members;
  }
  const next = new Set<string>();
  for (const member of members) {
    next.add(renames.get(member) ?? member);
  }
  return next;
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
  /**
   * Older ids for the same sender (Signal uuid ARCH §3.3: the number a member was
   * recorded under before identity became the uuid). Any of these already in
   * members is replaced by senderId; members not named here are left as they are.
   */
  legacySenderIds?: string[];
  cfg?: OpenClawConfig;
  agentId?: string;
  now?: number;
}): {
  dir: string;
  written: boolean;
  reason?: "disabled" | "throttled";
  /** §8.1: set when this write created the group or changed its name. */
  event?: GroupMemoryEvent;
} {
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
  // Always heal: a legacy-layout twin may sit alongside an already-created
  // canonical meta (the 2026-11-15 incident). Memoized; no-op when none exists.
  const existing = healLegacyGroupMemory({
    workspaceDir: params.workspaceDir,
    channel: params.channel.trim().toLowerCase(),
    groupId: params.groupId,
    canonicalDir: dir,
    existing: readGroupMemoryMeta(dir),
  });
  const senderId = params.senderId?.trim();
  const groupName = params.groupName?.trim();
  let members = new Set(
    Array.isArray(existing?.members)
      ? existing.members.filter((m): m is string => typeof m === "string")
      : [],
  );
  const renames = new Map<string, string>();
  if (senderId) {
    for (const legacy of params.legacySenderIds ?? []) {
      const legacyId = legacy?.trim();
      if (legacyId && legacyId !== senderId && members.has(legacyId)) {
        renames.set(legacyId, senderId);
      }
    }
  }
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
    // §8.2: every later reader has one place to look, even in the group's first minute.
    seedGroupContextFile(dir, meta.name);
    return {
      dir,
      written: true,
      event: {
        reason: "created",
        channel: meta.channel,
        groupId: meta.groupId,
        name: meta.name,
        dir,
        firstSeen: meta.firstSeen,
      },
    };
  }

  const nothingToWrite =
    !groupName &&
    (hadSender || !senderId) &&
    renames.size === 0 &&
    !pendingMembersByDir.has(dir) &&
    !pendingRenamesByDir.has(dir);
  const lastWrite = lastMetaWriteAtByDir.get(dir) ?? 0;
  if (now - lastWrite < GROUP_MEMORY_META_WRITE_THROTTLE_MS) {
    // Defer, don't drop: remember a new sender (or a member conversion) for the next write.
    if (senderId && !hadSender && renames.size === 0) {
      const pending = pendingMembersByDir.get(dir) ?? new Set<string>();
      pending.add(senderId);
      pendingMembersByDir.set(dir, pending);
    }
    if (renames.size > 0) {
      const pendingRenames = pendingRenamesByDir.get(dir) ?? new Map<string, string>();
      for (const [from, to] of renames) {
        pendingRenames.set(from, to);
      }
      pendingRenamesByDir.set(dir, pendingRenames);
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
  // Apply member conversions (deferred + current); stored ids are rewritten in place.
  const allRenames = new Map<string, string>([...(pendingRenamesByDir.get(dir) ?? []), ...renames]);
  members = applyMemberRenames(members, allRenames);

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
  pendingRenamesByDir.delete(dir);
  // §8.1: a changed name is a "renamed" event; ordinary updates carry none.
  const previousName = typeof existing.name === "string" ? existing.name : undefined;
  if (previousName !== undefined && next.name !== previousName) {
    return {
      dir,
      written: true,
      event: {
        reason: "renamed",
        channel: next.channel,
        groupId: next.groupId,
        name: next.name,
        dir,
        firstSeen: next.firstSeen,
      },
    };
  }
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
  let meta = readGroupMemoryMeta(dir);
  if (!meta) {
    meta = healLegacyGroupMemory({
      workspaceDir: params.workspaceDir,
      channel,
      groupId,
      canonicalDir: dir,
      existing: meta,
    });
  }
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
