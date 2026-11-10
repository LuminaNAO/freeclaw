// Mail push connectors (docs/design/mail-push.md §5, §6): shared types.

/** Read position of one folder: UIDVALIDITY and the last UID handed over. */
export type MailFolderCursor = {
  uidValidity: string;
  lastUid: number;
};

/** Provider cursor: one position per watched folder. Contains no mail content. */
export type MailCursor = {
  folders: Record<string, MailFolderCursor>;
};

export type MailAddress = {
  name?: string;
  address?: string;
};

/** One new message as a provider hands it over (headers + plain/HTML body, never attachment content). */
export type MailMessage = {
  folder: string;
  uidValidity: string;
  uid: number;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  date?: Date;
  subject?: string;
  messageId?: string;
  attachmentNames: string[];
  text?: string;
  html?: string;
};

export const MAIL_CONNECTOR_STATES = [
  "starting",
  "idle",
  "polling",
  "backoff",
  "auth-failed",
  "disabled",
] as const;

export type MailConnectorStateName = (typeof MAIL_CONNECTOR_STATES)[number];

/** What a provider reports about its connection. `detail` must never carry mail content or secrets. */
export type ConnectorState = {
  state: MailConnectorStateName;
  detail?: string;
  /** For backoff: when the next attempt starts (epoch ms). */
  retryAt?: number;
};

export type MailProviderStartContext = {
  cursor: MailCursor | null;
  /**
   * Hands over new messages (possibly none, e.g. a baseline or a UIDVALIDITY reset) together with
   * the cursor that is valid once they are delivered. Resolves when the connector has buffered them.
   */
  onMessages(msgs: MailMessage[], cursor: MailCursor): Promise<void>;
  onState(s: ConnectorState): void;
  signal: AbortSignal;
};

export interface MailProvider {
  /** Runs until the signal aborts (or the provider gives up, e.g. auth-failed). */
  start(ctx: MailProviderStartContext): Promise<void>;
  /** Connect + auth + folder select, no side effects. */
  test(): Promise<{ ok: boolean; detail: string }>;
}

export type MailLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};
