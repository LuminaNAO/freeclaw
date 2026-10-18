import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isErrorRepliesDisabled,
  isSlashCommandsDisabled,
  recordSuppressedSessionError,
} from "../../sessions/quiet-settings.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

/**
 * Quiet sessions ARCH §3.1 (`errorReplies: false`): report a turn failure that is kept out of the
 * chat. Logged, and recorded on the session entry so `openclaw status` shows it.
 */
export async function reportSuppressedTurnError(params: {
  sessionKey?: string;
  storePath?: string;
  text: string;
}): Promise<void> {
  const text = params.text.trim() || "turn failed";
  defaultRuntime.error?.(
    `turn error not posted (errorReplies off) session=${params.sessionKey ?? "unknown"}: ${text}`,
  );
  await recordSuppressedSessionError({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    text,
  });
}

/**
 * Quiet sessions ARCH §3.1: with `errorReplies: false`, drop `isError` payloads (provider error
 * text) from a turn's replies and report them. Unset: returns the input unchanged.
 */
export async function filterErrorPayloadsForQuietSession(params: {
  entry: Pick<SessionEntry, "errorReplies"> | undefined;
  sessionKey?: string;
  storePath?: string;
  payloads: ReplyPayload[];
}): Promise<ReplyPayload[]> {
  if (!isErrorRepliesDisabled(params.entry)) {
    return params.payloads;
  }
  const errors = params.payloads.filter((payload) => payload.isError === true);
  if (errors.length === 0) {
    return params.payloads;
  }
  await reportSuppressedTurnError({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    text: errors
      .map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n"),
  });
  return params.payloads.filter((payload) => payload.isError !== true);
}

const SESSION_COMMAND_RE = /^\/session(?:\s|$)/i;

function resolveCommandCandidates(ctx: MsgContext, cfg: OpenClawConfig, agentId: string): string[] {
  const raw = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  const stripped = stripStructuralPrefixes(raw).trim();
  const candidates = [stripped];
  const isGroup = ctx.ChatType === "group" || ctx.ChatType === "channel";
  if (isGroup) {
    candidates.push(stripMentions(stripped, ctx, cfg, agentId).trim());
  }
  return candidates;
}

/**
 * Quiet sessions ARCH §3.1 (`slashCommands: false`): decide, once per inbound message, whether
 * command parsing is off for it, and record the answer on `ctx.SlashCommandsDisabled`. Every
 * command/directive/reset/abort parse point honours the flag; the text itself is untouched and
 * reaches the model as ordinary text. Only messages starting with `/` are affected, native
 * (UI) commands are not, and an operator's `/session` command is always parsed.
 */
export function resolveQuietSlashCommands(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  entry?: Pick<SessionEntry, "slashCommands">;
}): boolean {
  const { ctx } = params;
  if (ctx.SlashCommandsDisabled === true) {
    return true;
  }
  if (DECIDED_ENABLED.has(ctx)) {
    return false;
  }
  const decided = decideQuietSlashCommands(params);
  if (decided) {
    ctx.SlashCommandsDisabled = true;
  } else {
    // Unset/allowed: leave the context untouched (byte-identical to today's behaviour).
    DECIDED_ENABLED.add(ctx);
  }
  return decided;
}

const DECIDED_ENABLED = new WeakSet<object>();

function decideQuietSlashCommands(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  entry?: Pick<SessionEntry, "slashCommands">;
}): boolean {
  const { ctx, cfg } = params;
  if (ctx.CommandSource === "native") {
    return false;
  }
  const sessionKey = ctx.SessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const entry = params.entry ?? lookupSessionEntry(cfg, sessionKey);
  if (!isSlashCommandsDisabled(entry)) {
    return false;
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const candidates = resolveCommandCandidates(ctx, cfg, agentId);
  if (!candidates.some((text) => text.startsWith("/"))) {
    return false;
  }
  if (candidates.some((text) => SESSION_COMMAND_RE.test(text))) {
    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: ctx.CommandAuthorized === true,
    });
    if (auth.senderIsOwner) {
      return false;
    }
  }
  return true;
}

function lookupSessionEntry(cfg: OpenClawConfig, sessionKey: string): SessionEntry | undefined {
  try {
    const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    return resolveSessionStoreEntry({ store, sessionKey }).existing;
  } catch {
    return undefined;
  }
}

/** Convenience for parse points: true when command parsing is off for this message. */
export function isSlashCommandParsingDisabled(ctx: Pick<MsgContext, "SlashCommandsDisabled">) {
  return ctx.SlashCommandsDisabled === true;
}
