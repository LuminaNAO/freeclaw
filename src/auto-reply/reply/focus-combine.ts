// Focus mode: the combined prompt for one session's waiting messages
// (docs/design/focus-mode.md §5.2). Messages in arrival order, each prefixed by its
// sender and time, under one header line. The route, account and reply target are
// the newest message's; the attachments of all of them are kept.
import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/config.js";
import { FOCUS_COMBINED_HEADER } from "../../infra/focus-mode.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";

export type FocusWaitingMessage = {
  ctx: MsgContext;
  images?: GetReplyOptions["images"];
  /** Arrival time of the stack file (used when the message carries no timestamp). */
  arrivalMs: number;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function senderLabel(ctx: MsgContext): string {
  return (
    text(ctx.SenderName) ??
    text(ctx.SenderUsername) ??
    text(ctx.SenderE164) ??
    text(ctx.SenderId) ??
    text(ctx.From) ??
    "unknown"
  );
}

function messageTime(message: FocusWaitingMessage, timeZone: string): string {
  const ts =
    typeof message.ctx.Timestamp === "number" && Number.isFinite(message.ctx.Timestamp)
      ? message.ctx.Timestamp
      : message.arrivalMs;
  const date = new Date(ts);
  return formatZonedTimestamp(date, { timeZone }) ?? date.toISOString();
}

function messageBody(ctx: MsgContext): string {
  return (
    text(ctx.BodyForAgent) ?? text(ctx.RawBody) ?? text(ctx.CommandBody) ?? text(ctx.Body) ?? ""
  );
}

function mediaList(ctx: MsgContext): {
  paths: string[];
  urls: string[];
  types: string[];
} {
  const paths = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths.slice()
    : ctx.MediaPath
      ? [ctx.MediaPath]
      : [];
  const urls = Array.isArray(ctx.MediaUrls)
    ? ctx.MediaUrls.slice()
    : ctx.MediaUrl
      ? [ctx.MediaUrl]
      : [];
  const count = Math.max(paths.length, urls.length);
  const rawTypes = Array.isArray(ctx.MediaTypes)
    ? ctx.MediaTypes.slice()
    : ctx.MediaType
      ? [ctx.MediaType]
      : [];
  const types = Array.from(
    { length: count },
    (_, i) => rawTypes[i] ?? ctx.MediaType ?? "application/octet-stream",
  );
  // Keep the path/url arrays aligned per attachment.
  while (paths.length < count) {
    paths.push(urls[paths.length] ?? "");
  }
  while (urls.length < count) {
    urls.push(paths[urls.length] ?? "");
  }
  return { paths, urls, types };
}

export function buildFocusCombinedPrompt(
  messages: FocusWaitingMessage[],
  cfg: OpenClawConfig,
): string {
  const timeZone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  const lines = [FOCUS_COMBINED_HEADER];
  for (const message of messages) {
    lines.push(
      `[${senderLabel(message.ctx)}, ${messageTime(message, timeZone)}] ${messageBody(message.ctx)}`,
    );
  }
  return lines.join("\n");
}

/**
 * One context for the combined turn: the newest message's context (route, account,
 * sender, thread, trust), with its body replaced by the combined prompt and the
 * attachments of every message merged in arrival order.
 */
export function buildFocusCombinedContext(
  messages: FocusWaitingMessage[],
  cfg: OpenClawConfig,
): { ctx: MsgContext; images?: GetReplyOptions["images"] } {
  if (messages.length === 0) {
    throw new Error("no waiting messages to combine");
  }
  const newest = messages[messages.length - 1];
  const prompt = buildFocusCombinedPrompt(messages, cfg);
  const ctx: MsgContext = {
    ...newest.ctx,
    Body: prompt,
    BodyForAgent: prompt,
    RawBody: prompt,
    CommandBody: prompt,
    BodyForCommands: prompt,
  };
  const paths: string[] = [];
  const urls: string[] = [];
  const types: string[] = [];
  for (const message of messages) {
    const media = mediaList(message.ctx);
    paths.push(...media.paths);
    urls.push(...media.urls);
    types.push(...media.types);
  }
  delete ctx.MediaPath;
  delete ctx.MediaUrl;
  delete ctx.MediaType;
  delete ctx.MediaPaths;
  delete ctx.MediaUrls;
  delete ctx.MediaTypes;
  if (paths.length > 0) {
    ctx.MediaPaths = paths;
    ctx.MediaUrls = urls;
    ctx.MediaTypes = types;
    ctx.MediaPath = paths[0];
    ctx.MediaUrl = urls[0];
    ctx.MediaType = types[0];
  }
  const sids = messages
    .flatMap((m) => [m.ctx.MessageSid])
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (sids.length > 0) {
    ctx.MessageSids = sids;
    ctx.MessageSidFirst = sids[0];
    ctx.MessageSidLast = sids[sids.length - 1];
  }
  const images = messages.flatMap((m) => m.images ?? []);
  return { ctx, images: images.length > 0 ? images : undefined };
}
