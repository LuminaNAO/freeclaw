import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  formatFieldForLog,
  formatIdentityForLog,
  hashForLog,
  type SignalEnvelopeIdentity,
  type SignalTrustDenyReason,
} from "./identity.js";

export const SIGNAL_TRUST_ATTEMPTS_MAX_BYTES = 1024 * 1024;
export const SIGNAL_TRUST_COALESCE_WINDOW_MS = 10 * 60 * 1000;
export const SIGNAL_TRUST_COALESCE_MAX_KEYS = 1024;
export const SIGNAL_TRUST_GLOBAL_LINES_PER_MINUTE = 30;

export type SignalTrustAttemptKind = "dm" | "group" | "reaction" | "other";

export type SignalTrustAttempt = {
  accountId: string;
  identity: SignalEnvelopeIdentity;
  reason: SignalTrustDenyReason;
  kind: SignalTrustAttemptKind;
  /** Raw group id; only its hash prefix is ever written. */
  groupId?: string;
  flag: boolean;
};

export type SignalTrustAttemptRecord = {
  ts: string;
  accountId: string;
  number: string | null;
  uuid: string | null;
  reason: SignalTrustDenyReason;
  kind: SignalTrustAttemptKind;
  group: string | null;
  count: number;
};

export function resolveSignalTrustAttemptsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "security", "signal-trust-attempts.jsonl");
}

type CoalesceEntry = {
  windowStart: number;
  suppressed: number;
  last: SignalTrustAttempt;
};

/**
 * Denial log + flag with bounded output (ARCH §4.6): first denial per (account, sender key) is
 * emitted immediately; repeats inside the window are counted and reported once the window
 * closes. A global per-minute line cap and an LRU key cap bound a many-sender flood.
 */
export function createSignalTrustAttemptRecorder(params: {
  warn: (message: string) => void;
  error: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  filePath?: string;
  now?: () => number;
  maxBytes?: number;
}) {
  const now = params.now ?? Date.now;
  const filePath = params.filePath ?? resolveSignalTrustAttemptsPath(params.env);
  const maxBytes = params.maxBytes ?? SIGNAL_TRUST_ATTEMPTS_MAX_BYTES;
  const coalesce = new Map<string, CoalesceEntry>();
  let minuteStart = now();
  let linesThisMinute = 0;
  let overflow = 0;
  let writeErrorLogged = false;
  let dirReady = false;

  const toRecord = (attempt: SignalTrustAttempt, count: number): SignalTrustAttemptRecord => ({
    ts: new Date(now()).toISOString(),
    accountId: attempt.accountId,
    number: formatFieldForLog(attempt.identity.number),
    uuid: formatFieldForLog(attempt.identity.uuid),
    reason: attempt.reason,
    kind: attempt.kind,
    group: attempt.groupId ? `sha256:${hashForLog(attempt.groupId)}` : null,
    count,
  });

  const appendFlag = (record: SignalTrustAttemptRecord) => {
    try {
      if (!dirReady) {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") {
          fs.chmodSync(dir, 0o700);
        }
        dirReady = true;
      }
      const line = `${JSON.stringify(record)}\n`;
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {}
      if (size + Buffer.byteLength(line) > maxBytes) {
        fs.renameSync(filePath, `${filePath}.1`);
      }
      fs.appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      if (!writeErrorLogged) {
        writeErrorLogged = true;
        params.error(`signal trust gate: attempt flag write failed: ${String(err)}`);
      }
    }
  };

  const tickMinute = (t: number) => {
    if (t - minuteStart < 60_000) {
      return;
    }
    if (overflow > 0) {
      params.warn(
        `signal trust gate: ${overflow} additional denial log lines suppressed (rate cap)`,
      );
      overflow = 0;
    }
    minuteStart = t;
    linesThisMinute = 0;
  };

  // First sighting records count=1; a window summary records only the repeats it covers.
  const emitLine = (attempt: SignalTrustAttempt, suppressed: number) => {
    const record = toRecord(attempt, suppressed === 0 ? 1 : suppressed);
    if (attempt.flag) {
      appendFlag(record);
    }
    if (linesThisMinute >= SIGNAL_TRUST_GLOBAL_LINES_PER_MINUTE) {
      overflow += 1;
      return;
    }
    linesThisMinute += 1;
    const group = record.group ? ` group=${record.group}` : "";
    params.warn(
      `signal trust gate: denied account=${attempt.accountId} sender=${formatIdentityForLog(attempt.identity)} reason=${attempt.reason} kind=${attempt.kind}${group} suppressed=${suppressed}`,
    );
  };

  const keyFor = (attempt: SignalTrustAttempt) =>
    `${attempt.accountId}|${formatIdentityForLog(attempt.identity)}|${attempt.reason}`;

  function flushExpired(t: number) {
    for (const [key, entry] of coalesce) {
      if (t - entry.windowStart < SIGNAL_TRUST_COALESCE_WINDOW_MS) {
        continue;
      }
      coalesce.delete(key);
      if (entry.suppressed > 0) {
        emitLine(entry.last, entry.suppressed);
      }
    }
  }

  function record(attempt: SignalTrustAttempt) {
    const t = now();
    tickMinute(t);
    flushExpired(t);
    const key = keyFor(attempt);
    const existing = coalesce.get(key);
    if (existing) {
      existing.suppressed += 1;
      existing.last = attempt;
      coalesce.delete(key);
      coalesce.set(key, existing);
      return;
    }
    if (coalesce.size >= SIGNAL_TRUST_COALESCE_MAX_KEYS) {
      const oldestKey = coalesce.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = coalesce.get(oldestKey);
        coalesce.delete(oldestKey);
        if (oldest && oldest.suppressed > 0) {
          emitLine(oldest.last, oldest.suppressed);
        }
      }
    }
    coalesce.set(key, { windowStart: t, suppressed: 0, last: attempt });
    emitLine(attempt, 0);
  }

  return { filePath, record, flush: () => flushExpired(Number.POSITIVE_INFINITY) };
}

export async function readSignalTrustAttempts(params: {
  env?: NodeJS.ProcessEnv;
  accountId?: string;
  limit?: number;
}): Promise<SignalTrustAttemptRecord[]> {
  const filePath = resolveSignalTrustAttemptsPath(params.env);
  const lines: string[] = [];
  for (const candidate of [`${filePath}.1`, filePath]) {
    try {
      lines.push(...(await fs.promises.readFile(candidate, "utf8")).split("\n"));
    } catch {}
  }
  const records: SignalTrustAttemptRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as SignalTrustAttemptRecord;
      if (!params.accountId || parsed.accountId === params.accountId) {
        records.push(parsed);
      }
    } catch {}
  }
  const limit = params.limit ?? 50;
  return records.slice(-limit);
}
