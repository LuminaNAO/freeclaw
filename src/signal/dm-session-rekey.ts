/**
 * Signal DM session continuity (docs/design/signal-uuid-identity.md §4).
 *
 * DM session keys are built from the peer id. A sender who used to resolve by
 * number had `…:signal:direct:+<number>`; the same person now resolves to
 * `…:signal:direct:uuid:<uuid>`. On their next inbound DM the phone-keyed store
 * entry is re-keyed to the uuid key in one store write: same sessionId (so the
 * same transcript), same overrides. Never two live sessions for one person.
 */
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  updateSessionStore,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { maskSignalNumber } from "./identity.js";

export type SignalDmSessionRekeyResult =
  | { status: "rekeyed"; sessionId: string }
  /** §4.2: both keys exist; the uuid key wins and the phone entry is left untouched. */
  | { status: "both-exist" }
  | { status: "noop" };

// §4.2 notice is logged once per (store, phone key) per process, not on every message.
const reportedBothExist = new Set<string>();

/** @internal Test hook. */
export function resetSignalDmSessionRekeyNoticesForTests(): void {
  reportedBothExist.clear();
}

function stripSignalPrefix(value: string): string {
  return value.replace(/^signal:/i, "").trim();
}

function isPhoneTarget(value: string | undefined, phoneE164: string): boolean {
  return typeof value === "string" && stripSignalPrefix(value) === phoneE164;
}

/** Point routing fields that still name the number at the uuid (§1: writes are uuid-only). */
function rewriteRoutingToUuid(
  entry: SessionEntry,
  phoneE164: string,
  uuidRecipient: string,
): SessionEntry {
  const next: SessionEntry = { ...entry };
  if (isPhoneTarget(next.lastTo, phoneE164)) {
    next.lastTo = uuidRecipient;
  }
  if (next.deliveryContext && isPhoneTarget(next.deliveryContext.to, phoneE164)) {
    next.deliveryContext = { ...next.deliveryContext, to: uuidRecipient };
  }
  if (next.origin) {
    const origin = { ...next.origin };
    if (isPhoneTarget(origin.from, phoneE164)) {
      origin.from = `signal:${uuidRecipient}`;
    }
    if (isPhoneTarget(origin.to, phoneE164)) {
      origin.to = `signal:${uuidRecipient}`;
    }
    next.origin = origin;
  }
  return next;
}

export async function migrateSignalDmSessionToUuid(params: {
  storePath: string;
  /** Session key the sender had when they resolved by number. */
  phoneSessionKey: string;
  /** Session key the sender resolves to now (`…:direct:uuid:<uuid>`). */
  uuidSessionKey: string;
  /** The sender's secondary e164 (never logged unmasked). */
  phoneE164: string;
  /** Bare uuid, used as the new delivery target. */
  uuidRecipient: string;
  log?: (message: string) => void;
}): Promise<SignalDmSessionRekeyResult> {
  const { storePath, phoneSessionKey, uuidSessionKey } = params;
  if (
    !phoneSessionKey.trim() ||
    phoneSessionKey.trim().toLowerCase() === uuidSessionKey.trim().toLowerCase()
  ) {
    return { status: "noop" };
  }

  // Cheap pre-check so the common cases never take the lock or write the store:
  // nothing to move, or both keys exist (§4.2: phone entry left untouched).
  const cached = loadSessionStore(storePath);
  if (!resolveSessionStoreEntry({ store: cached, sessionKey: phoneSessionKey }).existing) {
    return { status: "noop" };
  }
  if (resolveSessionStoreEntry({ store: cached, sessionKey: uuidSessionKey }).existing) {
    const noticeKey = `${storePath}\u0000${phoneSessionKey.trim().toLowerCase()}`;
    if (reportedBothExist.has(noticeKey)) {
      return { status: "both-exist" };
    }
    reportedBothExist.add(noticeKey);
    return logResult({ status: "both-exist" }, params);
  }

  const result = await updateSessionStore(
    storePath,
    (store): SignalDmSessionRekeyResult => {
      const phone = resolveSessionStoreEntry({ store, sessionKey: phoneSessionKey });
      if (!phone.existing) {
        return { status: "noop" };
      }
      const uuid = resolveSessionStoreEntry({ store, sessionKey: uuidSessionKey });
      if (uuid.existing) {
        return { status: "both-exist" };
      }
      const moved = rewriteRoutingToUuid(phone.existing, params.phoneE164, params.uuidRecipient);
      store[uuid.normalizedKey] = moved;
      for (const key of new Set([phone.normalizedKey, ...phone.legacyKeys])) {
        if (key !== uuid.normalizedKey) {
          delete store[key];
        }
      }
      return { status: "rekeyed", sessionId: moved.sessionId };
    },
    { activeSessionKey: uuidSessionKey.trim().toLowerCase() },
  );

  return logResult(result, params);
}

function logResult(
  result: SignalDmSessionRekeyResult,
  params: { phoneE164: string; uuidRecipient: string; log?: (message: string) => void },
): SignalDmSessionRekeyResult {
  const masked = maskSignalNumber(params.phoneE164);
  if (result.status === "rekeyed") {
    params.log?.(
      `signal: re-keyed DM session ${masked} -> uuid:${params.uuidRecipient} (session ${result.sessionId} kept)`,
    );
  } else if (result.status === "both-exist") {
    params.log?.(
      `signal: DM sessions exist for both ${masked} and uuid:${params.uuidRecipient}; using the uuid session, phone-keyed entry left untouched`,
    );
  }
  return result;
}
