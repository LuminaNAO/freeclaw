// In-memory mail provider for tests (docs/design/mail-push.md §5 "fake"). Mailboxes live in a
// process-wide registry keyed by connector id, so tests (and `provider: "fake"` configs) can add
// mail without a server. Behaves like the imap provider: first start begins at "now", a
// UIDVALIDITY change resets the cursor without backfill.
import type {
  ConnectorState,
  MailCursor,
  MailMessage,
  MailProvider,
  MailProviderStartContext,
} from "../types.js";

export type FakeMailInput = Partial<Omit<MailMessage, "folder" | "uid" | "uidValidity">> & {
  folder?: string;
};

type FakeFolder = { uidValidity: string; nextUid: number; messages: MailMessage[] };

export class FakeMailbox {
  readonly folders = new Map<string, FakeFolder>();
  private readonly listeners = new Set<() => void>();
  /** Set to make test() fail (e.g. "auth"). */
  failTest: string | null = null;

  private folder(name: string): FakeFolder {
    let folder = this.folders.get(name);
    if (!folder) {
      folder = { uidValidity: "1", nextUid: 1, messages: [] };
      this.folders.set(name, folder);
    }
    return folder;
  }

  /** Adds a message and wakes running providers; returns it with its folder/UID. */
  add(input: FakeMailInput = {}): MailMessage {
    const folderName = input.folder ?? "INBOX";
    const folder = this.folder(folderName);
    const message: MailMessage = {
      from: [{ address: "sender@example.com" }],
      to: [{ address: "me@example.com" }],
      cc: [],
      attachmentNames: [],
      date: new Date(),
      subject: `Message ${folder.nextUid}`,
      text: `Body ${folder.nextUid}`,
      ...input,
      folder: folderName,
      uid: folder.nextUid,
      uidValidity: folder.uidValidity,
    };
    folder.nextUid += 1;
    folder.messages.push(message);
    this.notify();
    return message;
  }

  /** New UIDVALIDITY for a folder (messages renumbered from 1), like a server-side rebuild. */
  resetUidValidity(folderName = "INBOX"): void {
    const folder = this.folder(folderName);
    folder.uidValidity = String(Number(folder.uidValidity) + 1);
    folder.messages = folder.messages.map((message, index) => ({
      ...message,
      uid: index + 1,
      uidValidity: folder.uidValidity,
    }));
    folder.nextUid = folder.messages.length + 1;
    this.notify();
  }

  ensureFolder(name: string): void {
    this.folder(name);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const mailboxes = new Map<string, FakeMailbox>();

/** The fake mailbox of a connector (created on first use). */
export function getFakeMailbox(connectorId: string): FakeMailbox {
  let mailbox = mailboxes.get(connectorId);
  if (!mailbox) {
    mailbox = new FakeMailbox();
    mailboxes.set(connectorId, mailbox);
  }
  return mailbox;
}

export function resetFakeMailboxes(): void {
  mailboxes.clear();
}

export class FakeMailProvider implements MailProvider {
  constructor(
    private readonly mailbox: FakeMailbox,
    private readonly folders: string[] = ["INBOX"],
  ) {}

  async test(): Promise<{ ok: boolean; detail: string }> {
    if (this.mailbox.failTest) {
      return { ok: false, detail: this.mailbox.failTest };
    }
    for (const folder of this.folders) {
      this.mailbox.ensureFolder(folder);
    }
    const counts = this.folders.map(
      (folder) => `${folder}: ${this.mailbox.folders.get(folder)?.messages.length ?? 0} message(s)`,
    );
    return { ok: true, detail: `fake mailbox, ${counts.join(", ")}` };
  }

  async start(ctx: MailProviderStartContext): Promise<void> {
    const cursor: MailCursor = { folders: {} };
    for (const folderName of this.folders) {
      this.mailbox.ensureFolder(folderName);
    }
    let baselineChanged = false;
    for (const folderName of this.folders) {
      const folder = this.mailbox.folders.get(folderName)!;
      const stored = ctx.cursor?.folders[folderName];
      if (stored && stored.uidValidity === folder.uidValidity) {
        cursor.folders[folderName] = { ...stored };
      } else {
        cursor.folders[folderName] = {
          uidValidity: folder.uidValidity,
          lastUid: folder.nextUid - 1,
        };
        baselineChanged = true;
      }
    }
    if (baselineChanged) {
      await ctx.onMessages([], clone(cursor));
    }
    ctx.onState({ state: "idle" } satisfies ConnectorState);

    let wake: (() => void) | null = null;
    let dirty = true;
    const unsubscribe = this.mailbox.subscribe(() => {
      dirty = true;
      wake?.();
    });
    const onAbort = () => wake?.();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!ctx.signal.aborted) {
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        dirty = false;
        for (const folderName of this.folders) {
          const folder = this.mailbox.folders.get(folderName)!;
          const pos = cursor.folders[folderName];
          if (!pos || pos.uidValidity !== folder.uidValidity) {
            cursor.folders[folderName] = {
              uidValidity: folder.uidValidity,
              lastUid: folder.nextUid - 1,
            };
            await ctx.onMessages([], clone(cursor));
            continue;
          }
          const fresh = folder.messages.filter((message) => message.uid > pos.lastUid);
          if (fresh.length === 0) {
            continue;
          }
          cursor.folders[folderName] = {
            uidValidity: folder.uidValidity,
            lastUid: fresh[fresh.length - 1].uid,
          };
          await ctx.onMessages(
            fresh.map((message) => ({ ...message })),
            clone(cursor),
          );
          if (ctx.signal.aborted) {
            return;
          }
        }
      }
    } finally {
      unsubscribe();
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }
}

function clone(cursor: MailCursor): MailCursor {
  return {
    folders: Object.fromEntries(
      Object.entries(cursor.folders).map(([folder, pos]) => [folder, { ...pos }]),
    ),
  };
}
