// Focus mode gate at inbound dispatch (docs/design/focus-mode.md §3).
// Runs at the same point as the restart-drain check (stack §6), after the stack
// file is written. A held message keeps its file on disk and starts no turn.
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  FOCUS_BUSY_NOTICE,
  type FocusState,
  holdFocusFiles,
  isFocusModeCommandText,
  markFocusNotified,
} from "../../infra/focus-mode.js";
import { finishStackFiles } from "../../infra/session-stack.js";
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { normalizeCommandBody } from "../commands-registry.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

function commandText(ctx: FinalizedMsgContext): string {
  const raw = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  return normalizeCommandBody(typeof raw === "string" ? raw : "", { botUsername: ctx.BotUsername });
}

/**
 * `/focusmode` while focused away. §3.4 escape hatch: an operator's command is always
 * handled ("operator"). §4: anyone else gets the standard refusal ("refused": ignored,
 * no turn, nothing kept for replay), exactly as the command handler refuses it.
 */
function classifyFocusModeCommand(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): "operator" | "refused" | undefined {
  if (!isFocusModeCommandText(commandText(ctx))) {
    return undefined;
  }
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized: ctx.CommandAuthorized,
  });
  return auth.isAuthorizedSender && auth.senderIsOwner ? "operator" : "refused";
}

/**
 * §3.1-§3.2. Returns true when the message is held (the caller returns without
 * starting the turn). The stack files stay on disk; the sender gets the busy notice
 * at most once per session per focus period.
 */
export async function holdForFocus(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  sessionKey: string;
  stackFiles: string[];
  /** The focus that holds this session (focusHolding). */
  focus: FocusState;
}): Promise<boolean> {
  const { ctx, cfg, dispatcher, sessionKey, stackFiles, focus } = params;
  const focusCommand = classifyFocusModeCommand(ctx, cfg);
  if (focusCommand === "operator") {
    return false;
  }
  if (focusCommand === "refused") {
    logVerbose(`Ignoring /focusmode from non-operator sender: ${redactIdentifier(ctx.SenderId)}`);
    finishStackFiles(stackFiles);
    return true;
  }
  holdFocusFiles(sessionKey, stackFiles.slice());
  logVerbose(`focus mode: held inbound for ${sessionKey} (focused on ${focus.target})`);
  if (markFocusNotified(sessionKey)) {
    await sendBusyNotice({ ctx, cfg, dispatcher });
  }
  return true;
}

/** The session's send policy applies to the notice as to any reply (§3.2). */
function isSendDenied(ctx: FinalizedMsgContext, cfg: OpenClawConfig): boolean {
  const sessionKey = ctx.SessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  let entry: SessionEntry | undefined;
  try {
    const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const store = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId }));
    entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
  } catch {
    entry = undefined;
  }
  return (
    resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel ?? ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? undefined,
      chatType: entry?.chatType,
    }) === "deny"
  );
}

/** A normal reply (§3.2): same route as any reply to this message. */
async function sendBusyNotice(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
}): Promise<void> {
  const { ctx, cfg, dispatcher } = params;
  if (isSendDenied(ctx, cfg)) {
    return;
  }
  const payload = { text: FOCUS_BUSY_NOTICE };
  const originatingChannel = normalizeMessageChannel(ctx.OriginatingChannel);
  const currentSurface =
    normalizeMessageChannel(ctx.Provider) ?? normalizeMessageChannel(ctx.Surface);
  const routeElsewhere =
    isRoutableChannel(originatingChannel) &&
    Boolean(ctx.OriginatingTo) &&
    originatingChannel !== currentSurface;
  if (routeElsewhere && originatingChannel && ctx.OriginatingTo) {
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: ctx.OriginatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      cfg,
    });
    if (!result.ok) {
      logVerbose(`focus mode: busy notice route failed: ${result.error ?? "unknown error"}`);
    }
    return;
  }
  dispatcher.sendFinalReply(payload);
}
