import { msgIdFor, type DeliveryRequest, type RunEnd } from "./delivery.js";
import type { SwarmEngine, TaskState } from "./engine.js";
import { isMemberRole, membersOf, RELAY_ROLE, type Holon } from "./holon.js";
import { MEMBER_POSTED } from "./members.js";
import { TASKMASTER } from "./routing.js";
import { readOutbox, type OutboxEntry, type SwarmEvent } from "./store.js";

// ARCH §7.1: the swarm heals itself. An open holon always has a next step in flight: a run
// error (whatever the run status says) is retried with backoff for every participant, the
// retry timer survives a restart, and an idle sweep re-delivers outstanding input.

export const RUN_ERROR = "RUN_ERROR";
export const RETRY_SCHEDULED = "RETRY_SCHEDULED";
export const RETRY_AFTER_ERROR = "RETRY_AFTER_ERROR";
export const RESUMED_IDLE = "RESUMED_IDLE";

/** ARCH §7.1.2: 30 s, 2 min, 5 min, 10 min, then every 15 min. */
export const TRANSIENT_BACKOFF_MS = [30_000, 120_000, 300_000, 600_000] as const;
export const STEADY_RETRY_MS = 15 * 60_000;
/** ARCH §7.1.5: the idle sweep runs once a minute. */
export const IDLE_SWEEP_MS = 60_000;

export type ErrorClass = "transient" | "quota" | "permanent";

const QUOTA_RE = /\b(403|429)\b|quota|rate[ -]?limit|insufficient[_ ]quota|resource[_ ]exhausted/i;
const TRANSIENT_RE =
  /\btim(?:e|ed)[ _-]?out\b|timeout|\bETIMEDOUT\b|\b5\d\d\b|overload|unavailable|bad gateway|internal server error|\bECONNRESET\b|\bECONNREFUSED\b|\bECONNABORTED\b|\bEPIPE\b|\bEAI_AGAIN\b|connection (?:reset|refused|closed|aborted|error)|socket hang up|network error|fetch failed|stream (?:error|ended|closed|interrupted)|premature close/i;

export function isQuotaError(error: string | undefined): boolean {
  return Boolean(error && QUOTA_RE.test(error));
}

/**
 * ARCH §7.1.2: quota (403/429/quota) first, then transient (timeout, 5xx, overloaded,
 * connection reset/refused, stream error). Anything else (4xx, schema, auth, or no reason at
 * all) keeps the v1 rule: one retry, then FAILED.
 */
export function classifyRunError(error: string | undefined): ErrorClass {
  if (isQuotaError(error)) {
    return "quota";
  }
  return error && TRANSIENT_RE.test(error) ? "transient" : "permanent";
}

/** Delay before retry `attempt` (1-based) of a transient error; quota waits 15 min. */
export function retryDelayMs(attempt: number, cls: ErrorClass = "transient"): number {
  if (cls === "quota") {
    return STEADY_RETRY_MS;
  }
  if (cls === "permanent") {
    return 0;
  }
  return TRANSIENT_BACKOFF_MS[attempt - 1] ?? STEADY_RETRY_MS;
}

/** The DELIVERED event that started a run, if the swarm started it. */
export function deliveryOfRun(events: SwarmEvent[], runId: string): SwarmEvent | undefined {
  return events.findLast(
    (e) => e.kind === "send" && e.event === "DELIVERED" && e.data?.runId === runId,
  );
}

/**
 * The role did its turn's job after `seq`: a worker or lead emitted; the relay routed or
 * asked (its emits are spoken as the member, ARCH §10a.3).
 */
export function answeredAfter(events: SwarmEvent[], role: string, seq: number): boolean {
  return events.some(
    (e) =>
      e.seq > seq &&
      ((e.kind === "emit" && e.from === role) ||
        (role === RELAY_ROLE &&
          e.kind === "system" &&
          (e.event === "RELAY_ROUTED" || e.event === "RELAY_ASKED"))),
  );
}

type TranscriptMessage = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  timestamp?: unknown;
  content?: unknown;
};

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : "",
      )
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * ARCH §7.1.1: the session's last assistant message, when it settled with `stopReason: error`
 * (and is not older than the run). Returns the provider's reason, or undefined for a normal end
 * or an unreadable transcript.
 */
export async function lastAssistantError(
  engine: SwarmEngine,
  sessionKey: string,
  sinceTs?: number,
): Promise<string | undefined> {
  const get = engine.runtime.subagent.getSessionMessages;
  if (!get) {
    return undefined;
  }
  let messages: unknown[];
  try {
    ({ messages } = await get({ sessionKey, limit: 20 }));
  } catch {
    return undefined;
  }
  const last = (messages as TranscriptMessage[]).findLast((m) => m?.role === "assistant");
  if (!last || last.stopReason !== "error") {
    return undefined;
  }
  if (typeof last.timestamp === "number" && sinceTs !== undefined && last.timestamp < sinceTs) {
    return undefined; // an earlier run's error, not this one's
  }
  const reason =
    typeof last.errorMessage === "string" && last.errorMessage.trim()
      ? last.errorMessage.trim()
      : textOf(last.content);
  return reason || "provider error";
}

/**
 * ARCH §7.1.1: the error a settled run ended in, whatever its status says. A run with status
 * "error" is an error; a run with status "ok" that did not do its job is one when its last
 * assistant message is `stopReason: error`.
 */
export async function runErrorOf(
  engine: SwarmEngine,
  taskId: string,
  role: string,
  end: RunEnd,
): Promise<string | undefined> {
  if (end.status === "aborted") {
    return undefined;
  }
  if (end.status === "error") {
    return end.error?.trim() || "run ended in error";
  }
  let events: SwarmEvent[];
  try {
    events = engine.loadState(taskId).events;
  } catch {
    return undefined;
  }
  const delivery = deliveryOfRun(events, end.runId);
  if (answeredAfter(events, role, delivery?.seq ?? 0)) {
    return undefined;
  }
  return lastAssistantError(engine, end.sessionKey, delivery?.ts);
}

// --- Retries (ARCH §7.1.2-4) ---------------------------------------------------------------

/** A line on top of a retried input; replaced (never stacked) on the next retry. */
const RETRY_LINE_RE = /^\[RETRY_AFTER_ERROR attempt \d+:[^\n]*\]\n/gm;

export function stripRetryLine(message: string): string {
  return message.replace(RETRY_LINE_RE, "");
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The outbox entry a run was started from (by its DELIVERED msg id). */
function entryOfRun(state: TaskState, outbox: OutboxEntry[], runId: string, role: string) {
  const delivered = deliveryOfRun(state.events, runId);
  const key = delivered?.msgId;
  return (
    (key ? outbox.find((o) => o.idempotencyKey === key) : undefined) ??
    outbox.findLast((o) => o.to === role)
  );
}

/** The RETRY_AFTER_ERROR that produced this entry (directly or as a merged part), if any. */
function retryBehind(state: TaskState, entry: OutboxEntry | undefined): SwarmEvent | undefined {
  if (!entry) {
    return undefined;
  }
  const keys = new Set([entry.idempotencyKey, ...(entry.supersedes ?? [])]);
  return state.events.findLast(
    (e) => e.kind === "system" && e.event === RETRY_AFTER_ERROR && keys.has(e.msgId ?? ""),
  );
}

/** A RETRY_SCHEDULED that has not fired, is the role's latest, and is not moot. */
export function isPendingRetry(events: SwarmEvent[], sched: SwarmEvent): boolean {
  const role = String(sched.data?.role ?? "");
  if (answeredAfter(events, role, sched.seq)) {
    return false;
  }
  return !events.some(
    (e) =>
      e.seq > sched.seq &&
      ((e.event === RETRY_AFTER_ERROR && e.data?.scheduled === sched.seq) ||
        (e.event === RETRY_SCHEDULED && e.data?.role === role)),
  );
}

/**
 * ARCH §7.1.1-3: a run of `role` ended in `reason`. Logs RUN_ERROR, then: transient → retry
 * with backoff (never FAILED); quota → BLOCKED upstream (once per streak) and a retry every
 * 15 min; anything else → one retry, then FAILED. Every participant, the lead and the relay
 * included. Caller holds the task lock.
 */
export async function handleRunError(
  engine: SwarmEngine,
  state: TaskState,
  role: string,
  end: RunEnd,
  reason: string,
): Promise<void> {
  const taskId = state.contract.id;
  const cls = classifyRunError(reason);
  const outbox = readOutbox(engine.stateDir, taskId);
  const entry = entryOfRun(state, outbox, end.runId, role);
  const behind = retryBehind(state, entry);
  const prevSched = behind ? state.events.find((e) => e.seq === behind.data?.scheduled) : undefined;
  const attempt = behind ? Number(behind.data?.attempt ?? 0) + 1 : 1;
  // The run handed its work on before it errored: the next step is already in flight.
  const answered = answeredAfter(
    state.events,
    role,
    deliveryOfRun(state.events, end.runId)?.seq ?? 0,
  );
  engine.record(taskId, {
    kind: "system",
    event: RUN_ERROR,
    from: role,
    sha: state.sha,
    body: reason,
    data: {
      quota: cls === "quota",
      class: cls,
      attempt,
      runId: end.runId,
      ...(answered && { answered }),
    },
  });
  if (answered) {
    return;
  }
  if (cls === "permanent" && prevSched?.data?.class === "permanent") {
    // v1 rule for non-transient errors: one retry, then FAILED.
    await engine.toUpstream(taskId, state, {
      event: "FAILED",
      from: role,
      sha: state.sha,
      body: `${role} failed twice on the same input: ${reason}`,
    });
    engine.close(taskId, "failed");
    return;
  }
  if (cls === "quota" && prevSched?.data?.class !== "quota") {
    // ARCH §7: quota → upstream BLOCKED with the reason; §7.1.2: and it retries on its own.
    await engine.toUpstream(taskId, state, {
      event: "BLOCKED",
      from: role,
      sha: state.sha,
      body: `quota exhausted for ${role}: ${reason}; retrying every 15 min`,
    });
  }
  // The whole errored turn is retried: the input plus anything that queued into it (a merged
  // delivery), so a worker event that reached a down lead is never dropped (§7.1.3).
  const source = entry;
  const now = engine.timers.clock.now();
  const at = now + retryDelayMs(attempt, cls);
  const sched = engine.record(taskId, {
    kind: "system",
    event: RETRY_SCHEDULED,
    from: "swarm",
    sha: state.sha,
    data: {
      role,
      at,
      attempt,
      class: cls,
      reason: oneLine(reason),
      ...(source && { source: source.idempotencyKey }),
    },
  });
  const sessionKey = engine.sessionKey(taskId, role);
  if (cls === "permanent") {
    // Immediate, as v1: queued behind the ended run's release, never beside it (ARCH §5).
    await deliverRetry(engine, engine.loadState(taskId), sched, "deliver");
    return;
  }
  // Hold the session: nothing runs there until the retry, which carries what queued meanwhile.
  engine.mailbox.hold(sessionKey);
  armRetry(engine, taskId, sched);
}

function armRetry(engine: SwarmEngine, taskId: string, sched: SwarmEvent): void {
  const role = String(sched.data?.role ?? "");
  const at = Number(sched.data?.at ?? 0);
  engine.timers.armRetry(taskId, role, at, () =>
    fireRetry(engine, taskId, sched.seq).catch((err: unknown) => {
      engine.logger?.warn(
        `[swarm] retry for ${role} in ${taskId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }),
  );
}

/** The timer fired: deliver the retry unless the holon closed or the retry became moot. */
async function fireRetry(engine: SwarmEngine, taskId: string, schedSeq: number): Promise<void> {
  await engine.locks.run(taskId, async () => {
    let state: TaskState;
    try {
      state = engine.loadState(taskId);
    } catch {
      return;
    }
    const sched = state.events.find((e) => e.seq === schedSeq);
    const role = String(sched?.data?.role ?? "");
    const sessionKey = engine.sessionKey(taskId, role);
    if (!sched || state.status !== "open" || !isPendingRetry(state.events, sched)) {
      await engine.mailbox.unhold(sessionKey);
      return;
    }
    await deliverRetry(engine, state, sched, "release");
  });
}

/** Build and send the retry of a scheduled input: the same input, one line on top. */
async function deliverRetry(
  engine: SwarmEngine,
  state: TaskState,
  sched: SwarmEvent,
  mode: "release" | "deliver",
) {
  const taskId = state.contract.id;
  const role = String(sched.data?.role ?? "");
  const attempt = Number(sched.data?.attempt ?? 1);
  const outbox = readOutbox(engine.stateDir, taskId);
  const source = outbox.find((o) => o.idempotencyKey === sched.data?.source);
  const seqs = source?.seqs.length ? source.seqs : [sched.seq];
  const msgId = msgIdFor(taskId, seqs, `retry-${sched.seq}`);
  const original = source
    ? stripRetryLine(source.message)
    : [
        `TASK ${taskId} | FROM swarm | TO ${role}`,
        `EVENT ${RETRY_AFTER_ERROR} @ ${state.sha}`,
        `MSG ${msgId}`,
      ].join("\n");
  const withId = /^MSG \S+$/m.test(original)
    ? original.replace(/^MSG \S+$/m, `MSG ${msgId}`)
    : `MSG ${msgId}\n${original}`;
  const line =
    `[RETRY_AFTER_ERROR attempt ${attempt}: your previous run ended in an error ` +
    `(${String(sched.data?.reason ?? "run error")}); do this input again]`;
  engine.record(taskId, {
    kind: "system",
    event: RETRY_AFTER_ERROR,
    from: "swarm",
    sha: state.sha,
    msgId,
    data: {
      role,
      attempt,
      scheduled: sched.seq,
      class: sched.data?.class,
      source: sched.data?.source,
    },
  });
  const req: DeliveryRequest = {
    stateDir: engine.stateDir,
    taskId,
    targetSessionKey: engine.sessionKey(taskId, role),
    to: role,
    seqs,
    idempotencyKey: msgId,
    message: `${line}\n${withId}`,
    ...(source?.extraSystemPrompt && { extraSystemPrompt: source.extraSystemPrompt }),
  };
  return mode === "release" ? engine.mailbox.release(req) : engine.mailbox.deliver(req);
}

/**
 * ARCH §7.1.4: on resume, every scheduled retry that has not fired is armed again (and its
 * session held), at its logged time or at once when that time has passed. Returns the roles.
 */
export function rearmRetries(engine: SwarmEngine, state: TaskState): string[] {
  const latest = new Map<string, SwarmEvent>();
  for (const e of state.events) {
    if (e.kind === "system" && e.event === RETRY_SCHEDULED && typeof e.data?.role === "string") {
      latest.set(e.data.role, e);
    }
  }
  const roles: string[] = [];
  for (const [role, sched] of latest) {
    if (sched.data?.class === "permanent" || !isPendingRetry(state.events, sched)) {
      continue; // a permanent retry was delivered at once; resume's own steps cover it
    }
    engine.mailbox.hold(engine.sessionKey(state.contract.id, role));
    armRetry(engine, state.contract.id, sched);
    roles.push(role);
  }
  return roles;
}

// --- Idle sweep (ARCH §7.1.5) --------------------------------------------------------------

/** The line put on top of an input the sweep re-delivers. */
export const IDLE_LINE =
  "[the swarm found this holon idle with this input outstanding; check what is already done, then finish and emit]";

/** Every role with a session of its own in this holon: lane members, an agent lead, the relay. */
export function sessionRolesOf(holon: Holon): string[] {
  const members = holon.lanes.flatMap((l) =>
    l.count > 1 ? Array.from({ length: l.count }, (_, i) => `${l.role}:${i + 1}`) : [l.role],
  );
  return [
    ...members,
    ...(isMemberRole(holon, TASKMASTER) ? [] : [TASKMASTER]),
    ...(membersOf(holon).length > 0 ? [RELAY_ROLE] : []),
  ];
}

type Outstanding = { role: string; inputSeq: number; entry: OutboxEntry; undelivered: boolean };

/** The last undelivered or unanswered input of the holon, if any. */
export function outstandingInput(
  state: TaskState,
  outbox: OutboxEntry[],
  roles: string[],
): Outstanding | undefined {
  let best: Outstanding | undefined;
  for (const role of roles) {
    const entry = outbox.findLast((o) => o.to === role);
    if (!entry) {
      continue;
    }
    const inputSeq = Math.max(entry.seq, ...entry.seqs);
    const undelivered = outbox.some((o) => o.to === role && !o.acked);
    if (!undelivered && answeredAfter(state.events, role, inputSeq)) {
      continue;
    }
    if (!best || inputSeq > best.inputSeq) {
      best = { role, inputSeq, entry, undelivered };
    }
  }
  return best;
}

/**
 * The holon handed the next step to someone outside its sessions after this input: a member
 * (a line posted to the group, no reply since) or upstream / its parent (BLOCKED or FAILED).
 */
function waitingOutside(events: SwarmEvent[], inputSeq: number): boolean {
  const post = events.findLast((e) => e.kind === "send" && e.event === MEMBER_POSTED);
  const reply = events.findLast((e) => e.kind === "system" && e.event === "MEMBER_REPLY");
  if (post && post.seq > inputSeq && (!reply || reply.seq < post.seq)) {
    return true;
  }
  return events.some(
    (e) =>
      e.seq > inputSeq && e.kind === "upstream" && (e.event === "BLOCKED" || e.event === "FAILED"),
  );
}

/**
 * ARCH §7.1.5 for one holon. Caller holds the task lock. Returns the role it re-delivered to.
 * Repeats for the same input back off like a transient retry, so a session that keeps ending
 * silently is never driven harder than every 15 min.
 */
export async function sweepHolon(
  engine: SwarmEngine,
  taskId: string,
  openChildren: (taskId: string) => string[],
): Promise<string | undefined> {
  const state = engine.loadState(taskId);
  if (state.status !== "open") {
    return undefined;
  }
  const roles = sessionRolesOf(state.holon);
  const inFlight = roles.some(
    (r) =>
      !engine.mailbox.isIdle(engine.sessionKey(taskId, r)) || engine.timers.hasRetry(taskId, r),
  );
  if (inFlight || openChildren(taskId).length > 0) {
    return undefined;
  }
  const outbox = readOutbox(engine.stateDir, taskId);
  const found = outstandingInput(state, outbox, roles);
  if (!found || waitingOutside(state.events, found.inputSeq)) {
    return undefined;
  }
  const now = engine.timers.clock.now();
  const prior = state.events.filter(
    (e) =>
      e.event === RESUMED_IDLE &&
      e.data?.role === found.role &&
      e.data?.inputSeq === found.inputSeq,
  );
  const last = prior.at(-1);
  // The first repeat waits 2 min, then 5, 10 and 15 (the rule 2 steps after the first).
  if (last && now - Number(last.data?.at ?? 0) < retryDelayMs(prior.length + 1)) {
    return undefined;
  }
  const rec = engine.record(taskId, {
    kind: "system",
    event: RESUMED_IDLE,
    from: "swarm",
    sha: state.sha,
    data: { role: found.role, inputSeq: found.inputSeq, undelivered: found.undelivered, at: now },
  });
  const sessionKey = engine.sessionKey(taskId, found.role);
  if (found.undelivered) {
    // Never delivered: resend with its own key, so its ack settles it (ARCH §8).
    const covered = new Set(
      outbox.filter((o) => !o.acked && o.supersedes).flatMap((o) => o.supersedes ?? []),
    );
    for (const entry of outbox.filter(
      (o) => o.to === found.role && !o.acked && !covered.has(o.idempotencyKey),
    )) {
      await engine.mailbox.resend(engine.stateDir, taskId, entry);
    }
    return found.role;
  }
  const msgId = msgIdFor(taskId, [found.inputSeq], `idle-${rec.seq}`);
  const body = stripRetryLine(found.entry.message);
  const message = `${IDLE_LINE}\n${
    /^MSG \S+$/m.test(body) ? body.replace(/^MSG \S+$/m, `MSG ${msgId}`) : `MSG ${msgId}\n${body}`
  }`;
  await engine.mailbox.deliver({
    stateDir: engine.stateDir,
    taskId,
    targetSessionKey: sessionKey,
    to: found.role,
    seqs: found.entry.seqs.length > 0 ? found.entry.seqs : [found.inputSeq],
    idempotencyKey: msgId,
    message,
    ...(found.entry.extraSystemPrompt && { extraSystemPrompt: found.entry.extraSystemPrompt }),
  });
  return found.role;
}

/** ARCH §7.1.5: start the once-a-minute sweep on the engine's own clock. */
export function startIdleSweep(
  engine: SwarmEngine,
  openChildren: (taskId: string) => string[],
  onResumed?: (resumed: string[]) => void,
): void {
  engine.timers.startSweep(IDLE_SWEEP_MS, async () => {
    const resumed = await sweepIdle(engine, openChildren);
    if (resumed.length > 0) {
      onResumed?.(resumed);
    }
  });
}

/** One sweep over every open holon; one holon's failure never stops the others. */
export async function sweepIdle(
  engine: SwarmEngine,
  openChildren: (taskId: string) => string[],
): Promise<string[]> {
  const resumed: string[] = [];
  for (const taskId of engine.openTaskIds()) {
    try {
      const role = await engine.locks.run(taskId, () => sweepHolon(engine, taskId, openChildren));
      if (role) {
        resumed.push(`${taskId}:${role}`);
      }
    } catch (err) {
      engine.logger?.warn(
        `[swarm] idle sweep of ${taskId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return resumed;
}
