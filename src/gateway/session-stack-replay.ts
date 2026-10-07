// Session prompt stack startup replay (docs/design/durable-inbox.md §5).
// Each stored prompt is re-submitted, oldest first, through the ingress point it
// came from, unchanged. Its file is bound to the re-submitted payload so the
// normal turn-end rule (§3) deletes it; nothing new is written.
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "../auto-reply/reply/route-reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import { bindStackFiles, listStack, type StackEntry } from "../infra/session-stack.js";
import { isWebchatClient } from "../utils/message-channel.js";
import { agentHandlers } from "./server-methods/agent.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

type InboundPayload = { ctx: MsgContext; images?: GetReplyOptions["images"] };
type AgentPayload = { params: Record<string, unknown>; client: GatewayClient | null };

function replayInbound(
  entry: StackEntry,
  log: GatewayRequestContext["logGateway"],
): Promise<unknown> {
  const { ctx, images } = entry.content.payload as InboundPayload;
  bindStackFiles(ctx, [entry.file]);
  const cfg = loadConfig();
  const channel = ctx.OriginatingChannel;
  const to = ctx.OriginatingTo;
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      if (!isRoutableChannel(channel) || !to) {
        return;
      }
      await routeReply({
        payload,
        channel,
        to,
        sessionKey: ctx.SessionKey,
        accountId: ctx.AccountId,
        threadId: ctx.MessageThreadId,
        cfg,
      });
    },
    onError: (err) => log.warn(`stack replay delivery failed: ${String(err)}`),
  });
  return dispatchInboundMessage({ ctx, cfg, dispatcher, replyOptions: { images } });
}

/** Resolves when the replayed agent turn has ended (its final response). */
async function replayAgent(entry: StackEntry, context: GatewayRequestContext): Promise<void> {
  const { params, client } = entry.content.payload as AgentPayload;
  bindStackFiles(params, [entry.file]);
  await new Promise<void>((resolve) => {
    void agentHandlers.agent({
      req: { type: "req", id: `stack-replay:${String(params.idempotencyKey)}`, method: "agent" },
      params,
      client,
      isWebchatConnect: (connect) => isWebchatClient(connect?.client),
      respond: (ok, payload) => {
        const status = (payload as { status?: string } | undefined)?.status;
        if (!ok || status !== "accepted") {
          resolve();
        }
      },
      context,
    });
  });
}

/** §5: per session, oldest first, each through the ingress point it came from. */
export function replaySessionStack(context: GatewayRequestContext): Promise<void> {
  const log = context.logGateway;
  const sessions = listStack();
  if (sessions.length > 0) {
    log.info(`session stack: replaying ${sessions.length} session(s)`);
  }
  return Promise.all(
    sessions.map(async (session) => {
      for (const entry of session.entries) {
        try {
          if (entry.content.source === "agent") {
            await replayAgent(entry, context);
          } else {
            await replayInbound(entry, log);
          }
        } catch (err) {
          log.warn(`session stack replay failed for ${session.sessionKey}: ${String(err)}`);
        }
      }
    }),
  ).then(() => {});
}
