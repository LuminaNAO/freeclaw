import { logWarn } from "../logger.js";
import { evaluateSenderGroupAccessForPolicy } from "../plugin-sdk/group-access.js";
import { normalizeE164 } from "../utils.js";

/**
 * Signal identity is the ACI uuid (docs/design/signal-uuid-identity.md §1/§2).
 * A uuid sender may carry the phone number Signal supplied as `e164`; it is a
 * secondary match key for legacy allow-list entries (§3.1) and never an id.
 */
export type SignalSender =
  | { kind: "phone"; raw: string; e164: string }
  | { kind: "uuid"; raw: string; e164?: string };

type SignalAllowEntry =
  | { kind: "any" }
  | { kind: "phone"; e164: string }
  | { kind: "uuid"; raw: string };

const UUID_HYPHENATED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_RE = /^[0-9a-f]{32}$/i;

export function looksLikeUuid(value: string): boolean {
  if (UUID_HYPHENATED_RE.test(value) || UUID_COMPACT_RE.test(value)) {
    return true;
  }
  const compact = value.replace(/-/g, "");
  if (!/^[0-9a-f]+$/i.test(compact)) {
    return false;
  }
  return /[a-f]/i.test(compact);
}

function stripSignalPrefix(value: string): string {
  return value.replace(/^signal:/i, "").trim();
}

/**
 * §2.1: the uuid wins whenever the envelope carries one, even when Signal also
 * supplied the number; the number is kept only as the secondary `e164` match key.
 * A phone sender is returned only when there is no uuid at all.
 */
export function resolveSignalSender(params: {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
}): SignalSender | null {
  const sourceNumber = params.sourceNumber?.trim();
  const sourceUuid = params.sourceUuid?.trim();
  if (sourceUuid) {
    return sourceNumber
      ? { kind: "uuid", raw: sourceUuid.toLowerCase(), e164: normalizeE164(sourceNumber) }
      : { kind: "uuid", raw: sourceUuid.toLowerCase() };
  }
  if (sourceNumber) {
    return {
      kind: "phone",
      raw: sourceNumber,
      e164: normalizeE164(sourceNumber),
    };
  }
  return null;
}

/** The phone number Signal supplied for this sender, if any (secondary match key only). */
export function resolveSignalSenderE164(sender: SignalSender): string | undefined {
  return sender.e164;
}

/** Log-safe form of a phone number: keeps the country prefix and last two digits (§3.2). */
export function maskSignalNumber(value: string): string {
  const e164 = normalizeE164(value);
  const digits = e164.slice(1);
  if (digits.length <= 4) {
    return "+" + "*".repeat(Math.max(digits.length, 1));
  }
  return `+${digits.slice(0, 2)}${"*".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

export function formatSignalSenderId(sender: SignalSender): string {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}

export function formatSignalSenderDisplay(sender: SignalSender): string {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}

/**
 * §2.3: uuid senders get the uuid line and the number is never printed, even when
 * Signal supplied it. Only a sender with no uuid at all is identified by number.
 */
export function formatSignalPairingIdLine(sender: SignalSender): string {
  if (sender.kind === "phone") {
    return `Your Signal number: ${sender.e164}`;
  }
  return `Your Signal sender id: ${formatSignalSenderId(sender)}`;
}

export function resolveSignalRecipient(sender: SignalSender): string {
  return sender.kind === "phone" ? sender.e164 : sender.raw;
}

export function resolveSignalPeerId(sender: SignalSender): string {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}

function parseSignalAllowEntry(entry: string): SignalAllowEntry | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return { kind: "any" };
  }

  const stripped = stripSignalPrefix(trimmed);
  const lower = stripped.toLowerCase();
  if (lower.startsWith("uuid:")) {
    const raw = stripped.slice("uuid:".length).trim();
    if (!raw) {
      return null;
    }
    return { kind: "uuid", raw: raw.toLowerCase() };
  }

  if (looksLikeUuid(stripped)) {
    return { kind: "uuid", raw: stripped.toLowerCase() };
  }

  return { kind: "phone", e164: normalizeE164(stripped) };
}

/**
 * Canonical comparison form of an allow-list entry or sender id: `uuid:<lowercase uuid>`
 * for uuids, E.164 for numbers, `*` kept. Used by shared command/elevated matching so a
 * uuid is never mangled into digits.
 */
export function formatSignalAllowEntryForMatch(entry: string): string | undefined {
  const parsed = parseSignalAllowEntry(entry);
  if (!parsed) {
    return undefined;
  }
  if (parsed.kind === "any") {
    return "*";
  }
  return parsed.kind === "phone" ? parsed.e164 : `uuid:${parsed.raw}`;
}

/**
 * §3.3 write guard: the canonical `uuid:<uuid>` form of an entry freeclaw is about to
 * write, or undefined when the entry is not a uuid (numbers are never written).
 */
export function toSignalUuidAllowEntry(entry: string): string | undefined {
  const parsed = parseSignalAllowEntry(entry);
  return parsed?.kind === "uuid" ? `uuid:${parsed.raw}` : undefined;
}

export function normalizeSignalAllowRecipient(entry: string): string | undefined {
  const parsed = parseSignalAllowEntry(entry);
  if (!parsed || parsed.kind === "any") {
    return undefined;
  }
  return parsed.kind === "phone" ? parsed.e164 : parsed.raw;
}

export type SignalAllowMatchOptions = {
  /** Account the allow list belongs to; scopes the once-per-entry legacy warning (§3.2). */
  accountId?: string | null;
  /** Warning sink (defaults to the gateway logger). */
  warn?: (message: string) => void;
};

// §3.2: one warning per (phone entry, account) per process.
const warnedLegacyPhoneEntries = new Set<string>();

/** @internal Test hook: forget which legacy phone entries were already warned about. */
export function resetSignalLegacyAllowWarningsForTests(): void {
  warnedLegacyPhoneEntries.clear();
}

function warnLegacyPhoneEntry(
  e164: string,
  uuid: string,
  options: SignalAllowMatchOptions | undefined,
): void {
  const accountKey = options?.accountId?.trim() || "default";
  const key = `${accountKey}\u0000${e164}`;
  if (warnedLegacyPhoneEntries.has(key)) {
    return;
  }
  warnedLegacyPhoneEntries.add(key);
  const message = `signal allowFrom entry ${maskSignalNumber(e164)} matched uuid:${uuid} — replace it with the uuid`;
  if (options?.warn) {
    options.warn(message);
    return;
  }
  logWarn(message);
}

/**
 * §3.1: a `uuid:` entry matches the sender uuid; a phone entry matches the sender's
 * number (a phone sender's id, or a uuid sender's secondary e164) so existing configs
 * never lock anyone out. When only a phone entry let a uuid sender in, warn once (§3.2).
 * Config is never rewritten here.
 */
export function isSignalSenderAllowed(
  sender: SignalSender,
  allowFrom: string[],
  options?: SignalAllowMatchOptions,
): boolean {
  if (allowFrom.length === 0) {
    return false;
  }
  const parsed = allowFrom
    .map(parseSignalAllowEntry)
    .filter((entry): entry is SignalAllowEntry => entry !== null);
  if (parsed.some((entry) => entry.kind === "any")) {
    return true;
  }
  if (
    sender.kind === "uuid" &&
    parsed.some((entry) => entry.kind === "uuid" && entry.raw === sender.raw.toLowerCase())
  ) {
    return true;
  }
  const senderE164 = sender.e164;
  if (!senderE164) {
    return false;
  }
  const phoneMatch = parsed.find((entry) => entry.kind === "phone" && entry.e164 === senderE164);
  if (!phoneMatch) {
    return false;
  }
  if (sender.kind === "uuid") {
    warnLegacyPhoneEntry(senderE164, sender.raw, options);
  }
  return true;
}

export function isSignalGroupAllowed(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  allowFrom: string[];
  sender: SignalSender;
  accountId?: string | null;
}): boolean {
  return evaluateSenderGroupAccessForPolicy({
    groupPolicy: params.groupPolicy,
    groupAllowFrom: params.allowFrom,
    senderId: params.sender.raw,
    isSenderAllowed: () =>
      isSignalSenderAllowed(params.sender, params.allowFrom, { accountId: params.accountId }),
  }).allowed;
}
