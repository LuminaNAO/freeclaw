// IMAP mail provider (docs/design/mail-push.md §5): one connection per watched folder, opened
// read-only (EXAMINE), bodies fetched with BODY.PEEK. IDLE when the server supports it, polling
// otherwise; reconnect with backoff 5 s -> 5 min; UIDVALIDITY change resets the folder cursor to
// "now" without backfill; three authentication failures in a row stop the provider (auth-failed).
//
// Read-only: the provider never issues STORE, MOVE, COPY, EXPUNGE, APPEND, DELETE or similar.
import type { Readable } from "node:stream";
import {
  ImapFlow,
  type FetchMessageObject,
  type MessageAddressObject,
  type MessageStructureObject,
} from "imapflow";
import type { MailImapConfig } from "../../config/types.mail.js";
import { sleep } from "../connector.js";
import type {
  ConnectorState,
  MailAddress,
  MailCursor,
  MailLogger,
  MailMessage,
  MailProvider,
  MailProviderStartContext,
} from "../types.js";

export const IMAP_BACKOFF_BASE_MS = 5_000;
export const IMAP_BACKOFF_MAX_MS = 5 * 60_000;
export const IMAP_AUTH_FAILURES_BEFORE_STOP = 3;
export const IMAP_DEFAULT_POLL_SECONDS = 60;
/** IDLE is restarted this often so dead connections are noticed (RFC 2177 suggests < 29 min). */
const IDLE_RESTART_MS = 10 * 60_000;
/** Largest text part read per message; the event trims further to body.maxChars. */
const MAX_TEXT_PART_BYTES = 256 * 1024;
/** Messages fetched per round trip when catching up. */
const FETCH_CHUNK = 50;

export type ImapProviderOptions = {
  connectorId: string;
  imap: MailImapConfig;
  /** Resolved password (never logged). */
  password: string;
  log: MailLogger;
  /** Upper bound for the body text fetched per message (chars); defaults to 4x maxChars, min 16k. */
  maxBodyChars?: number;
  /** Test hooks. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Overrides pollSeconds (tests only; config enforces the 15 s minimum). */
  pollIntervalMs?: number;
  socketTimeoutMs?: number;
  tlsOptions?: { rejectUnauthorized?: boolean };
};

type AuthFailure = Error & { authenticationFailed?: boolean };

function isAuthFailure(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as AuthFailure).authenticationFailed);
}

function normalizeAddresses(list: MessageAddressObject[] | undefined): MailAddress[] {
  return (list ?? [])
    .map((entry) => ({
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.address ? { address: entry.address } : {}),
    }))
    .filter((entry) => entry.name || entry.address);
}

type BodyPlan = { textPart?: string; htmlPart?: string; attachmentNames: string[] };

function partFilename(node: MessageStructureObject): string | undefined {
  const name =
    node.dispositionParameters?.filename ?? node.parameters?.name ?? node.parameters?.filename;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** Picks the first text/plain and text/html parts and lists attachment names. */
export function planBodyParts(structure: MessageStructureObject | undefined): BodyPlan {
  const plan: BodyPlan = { attachmentNames: [] };
  if (!structure) {
    return plan;
  }
  const visit = (node: MessageStructureObject, isRoot: boolean) => {
    const type = (node.type ?? "").toLowerCase();
    if (node.childNodes && node.childNodes.length > 0) {
      for (const child of node.childNodes) {
        visit(child, false);
      }
      return;
    }
    const filename = partFilename(node);
    const isAttachment = node.disposition?.toLowerCase() === "attachment" || Boolean(filename);
    if (isAttachment) {
      if (filename) {
        plan.attachmentNames.push(filename);
      }
      return;
    }
    // A single-part message has no part number; imapflow addresses its body as part "1".
    const part = node.part ?? (isRoot ? "1" : undefined);
    if (!part) {
      return;
    }
    if (type === "text/plain" && !plan.textPart) {
      plan.textPart = part;
    } else if (type === "text/html" && !plan.htmlPart) {
      plan.htmlPart = part;
    }
  };
  visit(structure, true);
  return plan;
}

async function readLimited(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buf);
    size += buf.length;
    if (size >= maxBytes) {
      stream.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

class ImapAbort extends Error {}

export class ImapMailProvider implements MailProvider {
  private readonly opts: ImapProviderOptions;
  private readonly folders: string[];
  private authFailures = 0;
  private readonly folderStates = new Map<string, ConnectorState["state"]>();

  constructor(opts: ImapProviderOptions) {
    this.opts = opts;
    this.folders = opts.imap.folders?.length ? [...opts.imap.folders] : ["INBOX"];
  }

  private createClient(): ImapFlow {
    const { imap } = this.opts;
    const tls = imap.tls ?? true;
    return new ImapFlow({
      host: imap.host,
      port: imap.port ?? (tls === true ? 993 : 143),
      secure: tls === true,
      // STARTTLS must succeed when configured, so credentials never go out in cleartext.
      ...(tls === "starttls" ? { doSTARTTLS: true } : tls ? {} : { doSTARTTLS: false }),
      auth: { user: imap.user, pass: this.opts.password },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
      maxIdleTime: IDLE_RESTART_MS,
      ...(this.opts.socketTimeoutMs ? { socketTimeout: this.opts.socketTimeoutMs } : {}),
      ...(this.opts.tlsOptions ? { tls: this.opts.tlsOptions } : {}),
      clientInfo: { name: "openclaw-mail-push" },
    });
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    const client = this.createClient();
    client.on("error", () => {});
    try {
      await client.connect();
      const counts: string[] = [];
      for (const folder of this.folders) {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true });
        counts.push(`${folder}: ${mailbox.exists} message(s)`);
      }
      const idle = client.capabilities.has("IDLE") ? "IDLE supported" : "no IDLE (polling)";
      return { ok: true, detail: `connected, ${counts.join(", ")}; ${idle}` };
    } catch (err) {
      return {
        ok: false,
        detail: isAuthFailure(err)
          ? "authentication failed"
          : `connect failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async start(ctx: MailProviderStartContext): Promise<void> {
    // The shared cursor is updated per folder; each folder hands over a full cursor snapshot.
    const cursor: MailCursor = { folders: { ...ctx.cursor?.folders } };
    for (const folder of Object.keys(cursor.folders)) {
      if (!this.folders.includes(folder)) {
        delete cursor.folders[folder];
      }
    }
    const stopAll = new AbortController();
    const onAbort = () => stopAll.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const report = (folder: string, state: ConnectorState) => {
      this.folderStates.set(folder, state.state);
      ctx.onState(this.combineState(state));
    };
    try {
      await Promise.all(
        this.folders.map((folder) => this.watchFolder({ folder, cursor, ctx, stopAll, report })),
      );
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Worst state across folders wins, so one broken folder is visible. */
  private combineState(latest: ConnectorState): ConnectorState {
    const states = new Set(this.folderStates.values());
    for (const name of ["auth-failed", "backoff", "starting", "polling", "idle"] as const) {
      if (states.has(name)) {
        return name === latest.state ? latest : { state: name };
      }
    }
    return latest;
  }

  private async watchFolder(params: {
    folder: string;
    cursor: MailCursor;
    ctx: MailProviderStartContext;
    stopAll: AbortController;
    report: (folder: string, state: ConnectorState) => void;
  }): Promise<void> {
    const { folder, cursor, ctx, stopAll, report } = params;
    const signal = stopAll.signal;
    const base = this.opts.backoffBaseMs ?? IMAP_BACKOFF_BASE_MS;
    const max = this.opts.backoffMaxMs ?? IMAP_BACKOFF_MAX_MS;
    let attempt = 0;
    while (!signal.aborted) {
      report(folder, { state: "starting" });
      try {
        await this.session({
          folder,
          cursor,
          ctx,
          signal,
          report,
          onConnected: () => {
            attempt = 0;
            this.authFailures = 0;
          },
        });
        if (signal.aborted) {
          return;
        }
        throw new Error("connection closed");
      } catch (err) {
        if (signal.aborted || err instanceof ImapAbort) {
          return;
        }
        if (isAuthFailure(err)) {
          this.authFailures += 1;
          if (this.authFailures >= IMAP_AUTH_FAILURES_BEFORE_STOP) {
            report(folder, {
              state: "auth-failed",
              detail: `authentication failed ${this.authFailures} times; run: openclaw mail connectors restart ${this.opts.connectorId}`,
            });
            stopAll.abort();
            return;
          }
        }
        const delay = Math.min(max, base * 2 ** attempt);
        attempt += 1;
        const detail = isAuthFailure(err)
          ? `authentication failed (${this.authFailures}/${IMAP_AUTH_FAILURES_BEFORE_STOP})`
          : `${folder}: ${err instanceof Error ? err.message : String(err)}`;
        report(folder, { state: "backoff", detail, retryAt: Date.now() + delay });
        this.opts.log.warn(
          `mail connector ${this.opts.connectorId}: ${folder} disconnected, retry in ${Math.round(delay / 1000)}s`,
        );
        await sleep(delay, signal);
      }
    }
  }

  /** One connection: connect, examine, catch up, then IDLE or poll until it fails or stops. */
  private async session(params: {
    folder: string;
    cursor: MailCursor;
    ctx: MailProviderStartContext;
    signal: AbortSignal;
    report: (folder: string, state: ConnectorState) => void;
    onConnected: () => void;
  }): Promise<void> {
    const { folder, cursor, ctx, signal, report } = params;
    const client = this.createClient();
    let closed = false;
    let wakeUp: (() => void) | null = null;
    let changed = false;
    const closedPromise = new Promise<void>((resolve) => {
      client.on("close", () => {
        closed = true;
        resolve();
        wakeUp?.();
      });
    });
    client.on("error", () => {});
    client.on("exists", () => {
      changed = true;
      wakeUp?.();
    });
    const onAbort = () => {
      wakeUp?.();
      client.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await client.connect();
      params.onConnected();
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      const uidValidity = mailbox.uidValidity.toString();
      const stored = cursor.folders[folder];
      if (!stored || stored.uidValidity !== uidValidity) {
        // First start or UIDVALIDITY change: start from "now", nothing older is pushed.
        if (stored) {
          this.opts.log.warn(
            `mail connector ${this.opts.connectorId}: ${folder} UIDVALIDITY changed, cursor reset to now (no backfill)`,
          );
        }
        cursor.folders[folder] = { uidValidity, lastUid: Math.max(0, mailbox.uidNext - 1) };
        await ctx.onMessages([], snapshot(cursor));
      }
      let useIdle = (this.opts.imap.idle ?? true) && client.capabilities.has("IDLE");
      const pollMs =
        this.opts.pollIntervalMs ??
        (this.opts.imap.pollSeconds ?? IMAP_DEFAULT_POLL_SECONDS) * 1000;
      report(folder, { state: useIdle ? "idle" : "polling" });
      while (!signal.aborted && !closed) {
        changed = false;
        await this.catchUp({ client, folder, uidValidity, cursor, ctx, signal });
        if (signal.aborted || closed) {
          break;
        }
        if (client.mailbox && client.mailbox.uidValidity.toString() !== uidValidity) {
          throw new Error("UIDVALIDITY changed");
        }
        if (changed) {
          // New mail announced while catching up: look again before waiting.
          continue;
        }
        const woken = new Promise<void>((resolve) => {
          wakeUp = resolve;
        });
        if (useIdle) {
          // idle() keeps IDLE running (restarted every maxIdleTime) until another command
          // breaks it; the next SEARCH of catchUp does that after an EXISTS wake-up.
          const idling = client.idle().catch(() => false);
          const result = await Promise.race([idling, woken, closedPromise]);
          if (result === false && !signal.aborted && !closed) {
            // The server refused IDLE: fall back to polling on this connection.
            useIdle = false;
            report(folder, { state: "polling", detail: "IDLE refused, polling" });
          }
        } else {
          const timer = setTimeout(() => wakeUp?.(), pollMs);
          await Promise.race([woken, closedPromise]);
          clearTimeout(timer);
          if (!signal.aborted && !closed) {
            // NOOP lets the server report new messages (EXISTS) for the examined folder.
            await client.noop();
          }
        }
        wakeUp = null;
      }
      if (!signal.aborted && closed) {
        await closedPromise;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!closed) {
        await client.logout().catch(() => client.close());
      }
    }
  }

  /** Fetches every UID above the cursor and hands them over in chunks. */
  private async catchUp(params: {
    client: ImapFlow;
    folder: string;
    uidValidity: string;
    cursor: MailCursor;
    ctx: MailProviderStartContext;
    signal: AbortSignal;
  }): Promise<void> {
    const { client, folder, uidValidity, cursor, ctx, signal } = params;
    while (!signal.aborted) {
      const lastUid = cursor.folders[folder]?.lastUid ?? 0;
      const found = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      const uids = (Array.isArray(found) ? found : [])
        .filter((uid) => uid > lastUid)
        .toSorted((a, b) => a - b);
      if (uids.length === 0) {
        return;
      }
      const chunk = uids.slice(0, FETCH_CHUNK);
      const fetched = await client.fetchAll(
        chunk.join(","),
        { uid: true, envelope: true, bodyStructure: true, internalDate: true },
        { uid: true },
      );
      const byUid = new Map(fetched.map((entry) => [entry.uid, entry]));
      const messages: MailMessage[] = [];
      for (const uid of chunk) {
        const entry = byUid.get(uid);
        if (!entry) {
          continue;
        }
        messages.push(await this.toMailMessage(client, folder, uidValidity, entry));
      }
      if (signal.aborted) {
        throw new ImapAbort();
      }
      cursor.folders[folder] = { uidValidity, lastUid: chunk[chunk.length - 1] };
      await ctx.onMessages(messages, snapshot(cursor));
    }
  }

  private async toMailMessage(
    client: ImapFlow,
    folder: string,
    uidValidity: string,
    entry: FetchMessageObject,
  ): Promise<MailMessage> {
    const envelope = entry.envelope;
    const plan = planBodyParts(entry.bodyStructure);
    const maxBytes = Math.min(MAX_TEXT_PART_BYTES, (this.opts.maxBodyChars ?? 16_000) * 4);
    const readPart = async (part: string | undefined): Promise<string | undefined> => {
      if (!part) {
        return undefined;
      }
      // download() fetches with BODY.PEEK, so the message is not marked \Seen.
      const result = await client.download(String(entry.uid), part, { uid: true, maxBytes });
      return result.content ? await readLimited(result.content, maxBytes) : undefined;
    };
    const text = await readPart(plan.textPart);
    const html = text?.trim() ? undefined : await readPart(plan.htmlPart);
    const date = envelope?.date ? new Date(envelope.date) : undefined;
    return {
      folder,
      uidValidity,
      uid: entry.uid,
      from: normalizeAddresses(envelope?.from),
      to: normalizeAddresses(envelope?.to),
      cc: normalizeAddresses(envelope?.cc),
      ...(date && Number.isFinite(date.getTime()) ? { date } : {}),
      ...(envelope?.subject ? { subject: envelope.subject } : {}),
      ...(envelope?.messageId ? { messageId: envelope.messageId } : {}),
      attachmentNames: plan.attachmentNames,
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
    };
  }
}

function snapshot(cursor: MailCursor): MailCursor {
  return {
    folders: Object.fromEntries(
      Object.entries(cursor.folders).map(([folder, pos]) => [folder, { ...pos }]),
    ),
  };
}
