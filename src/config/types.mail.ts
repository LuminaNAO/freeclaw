import type { SecretInput } from "./types.secrets.js";

/** TLS mode of an IMAP connection: implicit TLS, STARTTLS upgrade, or plain (loopback only). */
export type MailImapTlsMode = boolean | "starttls";

export type MailImapConfig = {
  host: string;
  /** Default 993 with tls: true, 143 otherwise. */
  port?: number;
  /** true (implicit TLS, default) | "starttls" | false (only allowed for 127.0.0.1). */
  tls?: MailImapTlsMode;
  user: string;
  /** IMAP password as a SecretRef (env/file/exec). Plain strings are rejected. */
  password: SecretInput;
  /** Folders to watch (default ["INBOX"]). */
  folders?: string[];
  /** Use IMAP IDLE when the server supports it (default true); false = poll. */
  idle?: boolean;
  /** Poll interval when idle is false or unsupported (default 60, min 15). */
  pollSeconds?: number;
};

export type MailConnectorFilterConfig = {
  /** Sender address globs; a message must match one of them (when set). */
  from?: string[];
  /** Recipient (To/Cc) address globs; a message must match one of them (when set). */
  to?: string[];
  /** Subject substrings (case-insensitive); a message must contain one of them (when set). */
  subjectIncludes?: string[];
  /** Sender address globs to drop. */
  excludeFrom?: string[];
  /** Drop mail whose Date header is older than this many minutes. */
  maxAgeMinutes?: number;
};

export type MailConnectorBodyConfig = {
  /** Body text is trimmed to this many characters (default 8000). */
  maxChars?: number;
  /** "names" lists attachment file names (default), "none" omits them. Content is never included. */
  attachments?: "none" | "names";
};

export type MailConnectorBatchConfig = {
  /** Coalesce messages arriving within this window into one event (default 20 s, 0 = no wait). */
  windowSeconds?: number;
  /** Maximum messages per event; larger bursts are split (default 10). */
  max?: number;
};

export type MailConnectorAttachConfig = {
  agentId: string;
  /** Session that receives the events; must belong to agentId. Created if missing. */
  sessionKey: string;
  /** "now" runs an agent turn; "next-heartbeat" queues a system event (default "now"). */
  wakeMode?: "now" | "next-heartbeat";
  /** Deliver the agent reply to a chat (default false). */
  deliver?: boolean;
  /** Delivery channel id or "last"; only used when deliver is true. */
  channel?: string | null;
  /** Delivery target; only used when deliver is true. */
  to?: string | null;
  /** Workspace-relative instructions file named in the event (default "MAIL.md"). */
  instructionsFile?: string;
  /** Optional model override for the turn. */
  model?: string | null;
  /** Optional thinking level override for the turn. */
  thinking?: string | null;
};

export type MailConnectorConfig = {
  /** Connector id: [a-z0-9-], unique. */
  id: string;
  enabled?: boolean;
  provider: "imap" | "fake";
  imap?: MailImapConfig;
  filter?: MailConnectorFilterConfig;
  body?: MailConnectorBodyConfig;
  batch?: MailConnectorBatchConfig;
  attach: MailConnectorAttachConfig[];
};

export type MailConfig = {
  connectors?: MailConnectorConfig[];
};
