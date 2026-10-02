import { createHash } from "node:crypto";

export const SIGNAL_TRUST_E164_RE = /^\+[1-9]\d{6,14}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SignalTrustEntry = {
  number?: string;
  uuid?: string;
  addedAt?: string;
};

export type SignalTrustDenyReason =
  | "no_identity"
  | "malformed_identity"
  | "identity_conflict"
  | "not_trusted"
  | "store_invalid"
  | "recheck_denied";

/** A raw envelope field after strict validation. `raw` is kept only for hashing, never logged. */
export type SignalTrustField =
  | { state: "absent" }
  | { state: "valid"; value: string }
  | { state: "malformed"; raw: string };

export type SignalEnvelopeIdentity = {
  number: SignalTrustField;
  uuid: SignalTrustField;
};

export type SignalTrustDecision =
  | { allow: true; number?: string; uuid?: string }
  | { allow: false; reason: SignalTrustDenyReason; flag: boolean };

function readRawField(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  // Non-string identity fields are never valid; JSON-encode so they hash as malformed.
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Strict: never coerces. Formatted, bare-digit, or prefixed numbers are malformed. */
export function parseEnvelopeNumber(value: unknown): SignalTrustField {
  const raw = readRawField(value);
  if (raw === null || raw.trim() === "") {
    return { state: "absent" };
  }
  const trimmed = raw.trim();
  return SIGNAL_TRUST_E164_RE.test(trimmed)
    ? { state: "valid", value: trimmed }
    : { state: "malformed", raw };
}

/** Strict: hyphenated 8-4-4-4-12 only (any case), lowercased. Compact hex is malformed. */
export function parseEnvelopeUuid(value: unknown): SignalTrustField {
  const raw = readRawField(value);
  if (raw === null || raw.trim() === "") {
    return { state: "absent" };
  }
  const trimmed = raw.trim();
  return UUID_RE.test(trimmed)
    ? { state: "valid", value: trimmed.toLowerCase() }
    : { state: "malformed", raw };
}

export function parseEnvelopeIdentity(envelope: {
  sourceNumber?: unknown;
  sourceUuid?: unknown;
}): SignalEnvelopeIdentity {
  return {
    number: parseEnvelopeNumber(envelope.sourceNumber),
    uuid: parseEnvelopeUuid(envelope.sourceUuid),
  };
}

export function isCanonicalTrustNumber(value: unknown): value is string {
  return typeof value === "string" && SIGNAL_TRUST_E164_RE.test(value);
}

export function isCanonicalTrustUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_RE.test(value);
}

/**
 * Operator input (CLI) -> canonical store value. Accepts `signal:` / `uuid:` prefixes and
 * uppercase UUIDs; still rejects anything that is not a strict E.164 number or hyphenated UUID.
 */
export function canonicalizeTrustInput(
  input: string,
): { kind: "number"; value: string } | { kind: "uuid"; value: string } | null {
  let value = input.trim();
  value = value.replace(/^signal:/i, "").trim();
  if (/^uuid:/i.test(value)) {
    const uuid = parseEnvelopeUuid(value.slice("uuid:".length));
    return uuid.state === "valid" ? { kind: "uuid", value: uuid.value } : null;
  }
  const uuid = parseEnvelopeUuid(value);
  if (uuid.state === "valid") {
    return { kind: "uuid", value: uuid.value };
  }
  const number = parseEnvelopeNumber(value);
  if (number.state === "valid") {
    return { kind: "number", value: number.value };
  }
  return null;
}

/**
 * ARCH §4.3 decision rule. Only sourceNumber/sourceUuid are consulted; a conflict on any entry
 * denies even if another entry (or the other field) matches.
 */
export function decideSignalTrust(
  identity: SignalEnvelopeIdentity,
  trusted: readonly SignalTrustEntry[],
): SignalTrustDecision {
  const { number, uuid } = identity;
  if (number.state === "absent" && uuid.state === "absent") {
    return { allow: false, reason: "no_identity", flag: false };
  }
  if (number.state === "malformed" || uuid.state === "malformed") {
    return { allow: false, reason: "malformed_identity", flag: true };
  }
  const envNumber = number.state === "valid" ? number.value : undefined;
  const envUuid = uuid.state === "valid" ? uuid.value : undefined;

  let matched = false;
  for (const entry of trusted) {
    const numberMatch = envNumber !== undefined && entry.number === envNumber;
    const uuidMatch = envUuid !== undefined && entry.uuid === envUuid;
    if (!numberMatch && !uuidMatch) {
      continue;
    }
    const numberConflict =
      envNumber !== undefined && entry.number !== undefined && entry.number !== envNumber;
    const uuidConflict =
      envUuid !== undefined && entry.uuid !== undefined && entry.uuid !== envUuid;
    if (numberConflict || uuidConflict) {
      return { allow: false, reason: "identity_conflict", flag: true };
    }
    matched = true;
  }
  if (matched) {
    return { allow: true, number: envNumber, uuid: envUuid };
  }
  return { allow: false, reason: "not_trusted", flag: true };
}

export function hashForLog(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** Log-safe rendering: canonical values verbatim, malformed ones only as length + hash prefix. */
export function formatFieldForLog(field: SignalTrustField): string | null {
  if (field.state === "absent") {
    return null;
  }
  if (field.state === "valid") {
    return field.value;
  }
  return `malformed(len=${field.raw.length},sha256=${hashForLog(field.raw)})`;
}

export function formatIdentityForLog(identity: SignalEnvelopeIdentity): string {
  const number = formatFieldForLog(identity.number);
  const uuid = formatFieldForLog(identity.uuid);
  const parts = [number, uuid === null ? null : `uuid:${uuid}`].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(",") : "none";
}
