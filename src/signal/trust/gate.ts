import { logError, logWarn } from "../../logger.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createSignalTrustAttemptRecorder, type SignalTrustAttemptKind } from "./attempts.js";
import {
  decideSignalTrust,
  parseEnvelopeIdentity,
  type SignalEnvelopeIdentity,
  type SignalTrustDenyReason,
} from "./identity.js";
import { createSignalTrustStoreReader, type SignalTrustSnapshot } from "./store.js";

export const SIGNAL_TRUST_GATE_ENV = "OPENCLAW_SIGNAL_TRUST_GATE";

/**
 * Read from the process environment only (never openclaw.json), so chat `/config set` and
 * configWrites cannot flip it.
 */
export function isSignalTrustGateEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SIGNAL_TRUST_GATE_ENV]?.trim().toLowerCase() === "enforce";
}

declare const trustedSenderBrand: unique symbol;

/**
 * Proof that a sender passed the gate. Only this module can mint it, so sinks that require it
 * cannot be reached from a path that skipped the gate.
 */
export type SignalTrustedSender = {
  readonly [trustedSenderBrand]: true;
  readonly number?: string;
  readonly uuid?: string;
};

export type SignalTrustEvaluation =
  | { allow: true; trusted: SignalTrustedSender }
  | { allow: false; reason: SignalTrustDenyReason };

export type SignalTrustGate = {
  readonly enforced: boolean;
  evaluate: (params: {
    envelope: { sourceNumber?: unknown; sourceUuid?: unknown };
    kind: SignalTrustAttemptKind;
    groupId?: string;
  }) => Promise<SignalTrustEvaluation>;
  recheck: (
    trusted: SignalTrustedSender,
    context: { kind: SignalTrustAttemptKind; groupId?: string },
  ) => Promise<boolean>;
  describe: (endpoint: string) => Promise<string>;
};

const mintedTrusted = new WeakSet<object>();

function mintTrusted(number?: string, uuid?: string): SignalTrustedSender {
  const value = Object.freeze({ number, uuid }) as unknown as SignalTrustedSender;
  mintedTrusted.add(value);
  return value;
}

/** Gate-off mode: every sender passes, preserving pre-gate behavior exactly. */
function createPassThroughGate(): SignalTrustGate {
  return {
    enforced: false,
    evaluate: async ({ envelope }) => {
      const identity = parseEnvelopeIdentity(envelope);
      return {
        allow: true,
        trusted: mintTrusted(
          identity.number.state === "valid" ? identity.number.value : undefined,
          identity.uuid.state === "valid" ? identity.uuid.value : undefined,
        ),
      };
    },
    recheck: async (trusted) => mintedTrusted.has(trusted),
    describe: async (endpoint) => `signal trust gate: off (endpoint=${endpoint})`,
  };
}

export function createSignalTrustGate(params: {
  accountId: string;
  runtime: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  attemptsPath?: string;
  now?: () => number;
}): SignalTrustGate {
  const env = params.env ?? process.env;
  if (!isSignalTrustGateEnforced(env)) {
    return createPassThroughGate();
  }
  const reader = createSignalTrustStoreReader({
    accountId: params.accountId,
    env,
    filePath: params.storePath,
  });
  const warn = (message: string) => logWarn(message, params.runtime);
  const error = (message: string) => logError(message, params.runtime);
  const recorder = createSignalTrustAttemptRecorder({
    warn,
    error,
    env,
    filePath: params.attemptsPath,
    now: params.now,
  });

  // Logged once per store state change, never per event, so a flood cannot amplify it.
  let lastReportedGeneration = -1;
  const readSnapshot = async (): Promise<SignalTrustSnapshot> => {
    const snapshot = await reader.read();
    if (snapshot.generation !== lastReportedGeneration) {
      lastReportedGeneration = snapshot.generation;
      if (!snapshot.ok) {
        error(
          `signal trust gate: DENYING ALL senders for account=${params.accountId}: ${snapshot.error} (${reader.filePath}). Run \`openclaw signal trust add <id> --account ${params.accountId}\` or fix the file.`,
        );
      } else if (snapshot.trusted.length === 0) {
        warn(
          `signal trust gate: trust store for account=${params.accountId} is empty; all senders are denied`,
        );
      }
    }
    return snapshot;
  };

  const deny = (
    identity: SignalEnvelopeIdentity,
    reason: SignalTrustDenyReason,
    flag: boolean,
    context: { kind: SignalTrustAttemptKind; groupId?: string },
  ) => {
    recorder.record({
      accountId: params.accountId,
      identity,
      reason,
      kind: context.kind,
      groupId: context.groupId,
      flag,
    });
  };

  return {
    enforced: true,
    async evaluate({ envelope, kind, groupId }) {
      const identity = parseEnvelopeIdentity(envelope);
      const snapshot = await readSnapshot();
      if (!snapshot.ok) {
        deny(identity, "store_invalid", true, { kind, groupId });
        return { allow: false, reason: "store_invalid" };
      }
      const decision = decideSignalTrust(identity, snapshot.trusted);
      if (!decision.allow) {
        deny(identity, decision.reason, decision.flag, { kind, groupId });
        return { allow: false, reason: decision.reason };
      }
      return { allow: true, trusted: mintTrusted(decision.number, decision.uuid) };
    },
    async recheck(trusted, context) {
      const identity = parseEnvelopeIdentity({
        sourceNumber: trusted.number,
        sourceUuid: trusted.uuid,
      });
      if (!mintedTrusted.has(trusted)) {
        deny(identity, "recheck_denied", true, context);
        return false;
      }
      const snapshot = await readSnapshot();
      const allowed = snapshot.ok && decideSignalTrust(identity, snapshot.trusted).allow;
      if (!allowed) {
        deny(identity, "recheck_denied", true, context);
      }
      return allowed;
    },
    async describe(endpoint) {
      const snapshot = await readSnapshot();
      const trustedCount = snapshot.ok ? String(snapshot.trusted.length) : "invalid";
      return `signal trust gate: enforcing (account=${params.accountId}, trusted=${trustedCount}, endpoint=${endpoint})`;
    },
  };
}
