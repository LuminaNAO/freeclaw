// Session prompt stack startup replay (docs/design/durable-inbox.md §5).
// Each stored prompt is re-submitted, oldest first, through the ingress point it
// came from, unchanged. Its file is bound to the re-submitted payload so the
// normal turn-end rule (§3) deletes it; nothing new is written.
//
// Before replaying, two guards (docs/design/durable-inbox-stale-replay.md §2, §3):
// a file older than STACK_MAX_AGE_MS is dropped, and an inbound prompt whose
// message id is already a user turn in the session transcript is dropped (it was
// consumed; the transcript is the record).
import fs from "node:fs";
import path from "node:path";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "../auto-reply/reply/route-reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import {
  bindStackFiles,
  deleteStackFile,
  listStack,
  type StackEntry,
} from "../infra/session-stack.js";
import { isWebchatClient } from "../utils/message-channel.js";
import { agentHandlers } from "./server-methods/agent.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionTranscriptCandidates } from "./session-utils.fs.js";
import { loadSessionEntry } from "./session-utils.js";

type InboundPayload = { ctx: MsgContext; images?: GetReplyOptions["images"] };
type AgentPayload = { params: Record<string, unknown>; client: GatewayClient | null };

/** §3: a stack file older than this at startup is not replayed. */
export const STACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

function formatAgeHours(ageMs: number): string {
  return `${Math.max(0, Math.floor(ageMs / HOUR_MS))}h`;
}

function promptPreview(entry: StackEntry): string {
  const payload = entry.content.payload as {
    ctx?: { Body?: unknown };
    params?: { message?: unknown };
  };
  const raw = entry.content.source === "agent" ? payload?.params?.message : payload?.ctx?.Body;
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, 60);
}

/**
 * The inbound prompt's message id (`MessageSidFull ?? MessageSid`). The transcript
 * records `MessageSid ?? MessageSidFull`, so both forms are matched.
 */
function inboundMessageIds(entry: StackEntry): string[] {
  if (entry.content.source !== "inbound") {
    return [];
  }
  const ctx = (entry.content.payload as Partial<InboundPayload> | undefined)?.ctx;
  return [ctx?.MessageSidFull, ctx?.MessageSid]
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

/**
 * Message ids recorded on the user turns of a session's current transcript. The
 * reply pipeline writes them into the turn's untrusted conversation metadata
 * (`"message_id": "<id>"`), including each item of a collected turn.
 */
function transcriptUserMessageIds(sessionKey: string): Set<string> {
  const ids = new Set<string>();
  let file: string | undefined;
  try {
    const { storePath, entry } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId) {
      return ids;
    }
    file = resolveSessionTranscriptCandidates(entry.sessionId, storePath, entry.sessionFile).find(
      (candidate) => fs.existsSync(candidate),
    );
  } catch {
    return ids;
  }
  if (!file) {
    return ids;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return ids;
  }
  const idRe = /"message_id":\s*("(?:[^"\\]|\\.)*")/g;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes("message_id")) {
      continue;
    }
    let record: { message?: { role?: unknown } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record?.message?.role !== "user") {
      continue;
    }
    for (const match of messageText(record.message).matchAll(idRe)) {
      try {
        ids.add(JSON.parse(match[1]) as string);
      } catch {
        // Not a JSON string literal; ignore.
      }
    }
  }
  return ids;
}

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

/**
 * Stale replay ARCH §2, §3: drop what must not run again. Returns the entries to
 * replay; dropped files are deleted and logged.
 */
function dropStaleEntries(
  sessionKey: string,
  entries: StackEntry[],
  now: number,
  log: GatewayRequestContext["logGateway"],
): StackEntry[] {
  const keep: StackEntry[] = [];
  let transcriptIds: Set<string> | undefined;
  for (const entry of entries) {
    const name = path.basename(entry.file);
    const ageMs = now - entry.arrivalMs;
    if (ageMs > STACK_MAX_AGE_MS) {
      deleteStackFile(entry.file);
      log.info(`session stack: dropped expired ${sessionKey} ${name} age=${formatAgeHours(ageMs)}`);
      continue;
    }
    const messageIds = inboundMessageIds(entry);
    if (messageIds.length > 0) {
      transcriptIds ??= transcriptUserMessageIds(sessionKey);
      const seen = transcriptIds;
      if (messageIds.some((id) => seen.has(id))) {
        deleteStackFile(entry.file);
        log.info(`session stack: dropped stale ${sessionKey} ${name} (already in transcript)`);
        continue;
      }
    }
    keep.push(entry);
  }
  return keep;
}

/** §5: per session, oldest first, each through the ingress point it came from. */
export function replaySessionStack(context: GatewayRequestContext): Promise<void> {
  const log = context.logGateway;
  const now = Date.now();
  const sessions = listStack()
    .map((session) => ({
      ...session,
      entries: dropStaleEntries(session.sessionKey, session.entries, now, log),
    }))
    .filter((session) => session.entries.length > 0);
  if (sessions.length > 0) {
    log.info(`session stack: replaying ${sessions.length} session(s)`);
    // Stale replay ARCH §4: one line per file.
    for (const session of sessions) {
      for (const entry of session.entries) {
        log.info(
          `session stack: replay ${session.sessionKey} ${path.basename(entry.file)} age=${formatAgeHours(now - entry.arrivalMs)} source=${entry.content.source} ${JSON.stringify(promptPreview(entry))}`,
        );
      }
    }
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
