import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { updateGroupMemoryMetaOnInbound } from "../agents/group-memory.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGroupSessionKey } from "../config/sessions/group.js";
import { logVerbose } from "../globals.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    // Ensure dispatcher reservations are always released on every exit path.
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

/**
 * group-memory ARCH §3: on each inbound group message the gateway maintains
 * meta.json in <workspace>/group-memory/<channel>/<id>/ — create on first
 * sight (name from the channel's group subject when known), refresh lastSeen,
 * add new sender ids to members. Channel adapters already expose the group id
 * and subject in the inbound context; this shared hook needs no per-adapter
 * edits. Best-effort: group memory must never break message handling.
 */
function recordGroupMemoryMetaOnInbound(ctx: FinalizedMsgContext, cfg: OpenClawConfig): void {
  try {
    const group = resolveGroupSessionKey(ctx);
    if (!group?.channel || !group.id) {
      return;
    }
    const agentId = resolveSessionAgentId({ sessionKey: ctx.SessionKey, config: cfg });
    updateGroupMemoryMetaOnInbound({
      workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
      channel: group.channel,
      groupId: group.id,
      groupName: ctx.GroupSubject?.trim() || undefined,
      senderId: ctx.SenderId?.trim() || undefined,
      // Signal uuid ARCH §3.3: a member recorded under their number is converted to the
      // uuid id on their next message (the number is known then); others are untouched.
      legacySenderIds: ctx.SenderMatchE164?.trim() ? [ctx.SenderMatchE164.trim()] : undefined,
      cfg,
      agentId,
    });
  } catch (err) {
    logVerbose(`group memory meta update failed: ${String(err)}`);
  }
}

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  recordGroupMemoryMetaOnInbound(finalized, params.cfg);
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        replyResolver: params.replyResolver,
      }),
  });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );
  try {
    return await dispatchInboundMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    markDispatchIdle();
  }
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
