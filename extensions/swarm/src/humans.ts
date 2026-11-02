import type { DeliveryResult } from "./delivery.js";
import type { SwarmEngine, TaskState } from "./engine.js";
import { humansOf, type Holon } from "./holon.js";
import { TASKMASTER } from "./routing.js";
import type { SwarmEvent } from "./store.js";

// Humans over a channel (ARCH §3.3, §8, §10a.3). One channel group per holon that has a
// human lead or participant: opened on first need, closed (renamed `[done]`, left) when the
// holon is done. Events addressed to a human become one short plain line in that group; the
// human's replies go to the holon's relay session (relay.ts). Agent-only holons never get a
// group. No person, number or group id lives in code: humans come from the holon file, the
// root owner from plugin config, the group id from the channel and is kept in the events.

/** A channel's group API, as the swarm needs it. One per channel kind (fake, signal, …). */
export interface HolonChannel {
  readonly kind: string;
  /** Create a group with these members (channel ids); the agent identity is in it already. */
  createGroup(opts: { name: string; members: string[] }): Promise<{ groupId: string }>;
  /** One plain message to the group. */
  post(groupId: string, text: string): Promise<void>;
  /** Close a done holon's group: rename it and leave it. */
  closeGroup(groupId: string, opts: { name: string }): Promise<void>;
}

export type HumanChannelsOptions = {
  /** Channel kind → group API. A kind missing here is "no channel" for that holon (§8.3). */
  channels?: Record<string, HolonChannel>;
  /** Channel kind → the root owner's channel ids (always a member of a holon's group, §8.1). */
  owners?: Record<string, string[]>;
};

/** One line of at most this many characters goes to a human (ARCH §3.3 "short"). */
export const HUMAN_LINE_MAX = 280;

export const GROUP_OPENED = "GROUP_OPENED";
export const GROUP_CLOSED = "GROUP_CLOSED";
export const GROUP_UNAVAILABLE = "GROUP_UNAVAILABLE";
export const HUMAN_POSTED = "HUMAN_POSTED";
export const HUMAN_POST_FAILED = "HUMAN_POST_FAILED";

/** `<root> · <holon id>` (ARCH §8.1). */
export function groupNameFor(rootId: string, holonId: string): string {
  return `${rootId} · ${holonId}`;
}

/** What a human is asked to do for an event, in plain words (ARCH §3.3: what is needed). */
function neededFor(event: string, to: string): string {
  switch (event) {
    case "TASK_STARTED":
    case "ROUND_STARTED":
    case "LANE_WAITING":
    case "LANE_SETTLED":
      return "nothing yet; I will write when there is something to decide";
    case "TEST_PASS":
      return "say done if it is finished, or what is still missing";
    case "BLOCKED":
    case "LANE_STALLED":
    case "WORKER_EXIT_WITHOUT_EMIT":
    case "LANE_MERGE_CONFLICT":
    case "UNROUTED":
      return "tell me how to go on, or say stop";
    case "CANCELLED":
      return "nothing; the work is stopped";
    case "AUDIT_FAIL":
    case "TEST_FAIL":
      return "say retry to send it back to build, or how to go on";
    default:
      return to === TASKMASTER ? "approve, or say what to change" : "reply with what you decide";
  }
}

/**
 * ARCH §3.3, §10a.3: one short plain line for a human: what happened, what is needed, the sha.
 * Never a multi-line envelope; the full text stays in events.jsonl (`swarm show`).
 */
export function humanLine(msg: {
  event: string;
  from: string;
  to: string;
  sha: string;
  body: string;
}): string {
  const sha = msg.sha && msg.sha !== "init" ? ` @ ${msg.sha.slice(0, 10)}` : "";
  // The whole body folded onto one line (route note, then the sender's words), then cut.
  const what = msg.body
    .split("\n")
    .map((l) => l.trim().replace(/[.!?:;,\s]+$/, ""))
    .filter((l) => l.length > 0)
    .join(": ");
  const head = `${msg.event} from ${msg.from}${sha}`;
  const need = `Needed: ${neededFor(msg.event, msg.to)}.`;
  const room = HUMAN_LINE_MAX - head.length - need.length - 4;
  const said =
    what && room > 8 ? `: ${what.length > room ? `${what.slice(0, room - 1)}…` : what}` : "";
  return `${head}${said}. ${need}`;
}

/** Normalise a channel id for matching (`signal:+1…`, `uuid:…` and case do not matter). */
export function normalizeWho(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:(?=.)/, (p) => (p === "group:" ? p : ""))
    .replace(/^uuid:/, "");
}

/** The group a holon has open, from its events (ARCH §10a.3: the group id is in the events). */
export function openGroupOf(
  events: SwarmEvent[],
): { groupId: string; channel: string; name: string } | undefined {
  const opened = events.findLast((e) => e.kind === "system" && e.event === GROUP_OPENED);
  if (!opened || typeof opened.data?.groupId !== "string") {
    return undefined;
  }
  const closed = events.some(
    (e) =>
      e.kind === "system" &&
      e.event === GROUP_CLOSED &&
      e.seq > opened.seq &&
      e.data?.groupId === opened.data?.groupId,
  );
  if (closed) {
    return undefined;
  }
  return {
    groupId: opened.data.groupId,
    channel: String(opened.data.channel ?? ""),
    name: String(opened.data.name ?? ""),
  };
}

export type GroupStatus =
  | { ok: true; groupId: string; channel: string; name: string; opened: boolean }
  | { ok: false; reason: string };

/**
 * Channel groups for holons with humans. Lives on the engine; every frontend (CLI, method,
 * inbound hook, the fake channel) calls these same functions (ARCH §10a house standard).
 */
export class HumanChannels {
  readonly channels: Map<string, HolonChannel>;
  readonly owners: Record<string, string[]>;
  /** In-flight group work (opens, closes); tests and shutdown await it. */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(opts: HumanChannelsOptions = {}) {
    this.channels = new Map(Object.entries(opts.channels ?? {}));
    this.owners = opts.owners ?? {};
  }

  /** Register a channel's group API (the fake loopback in tests). */
  register(channel: HolonChannel): void {
    this.channels.set(channel.kind, channel);
  }

  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /**
   * The holon's group, opened on first need (ARCH §10a.3). An agent-only holon has none.
   * No channel → `BLOCKED: no channel` one level up, once (§8.3); everything else runs on.
   */
  async ensureGroup(
    engine: SwarmEngine,
    taskId: string,
    state: Pick<TaskState, "holon" | "events" | "sha" | "contract">,
  ): Promise<GroupStatus> {
    const humans = humansOf(state.holon);
    if (humans.length === 0) {
      return { ok: false, reason: "agent-only holon: no group (ARCH §8.1)" };
    }
    const events = engine.loadState(taskId).events;
    const open = openGroupOf(events);
    if (open) {
      return { ok: true, ...open, opened: false };
    }
    if (events.some((e) => e.kind === "system" && e.event === GROUP_CLOSED)) {
      return { ok: false, reason: "the holon's group is closed" };
    }
    const kind = humans[0]!.channel;
    const channel = this.channels.get(kind);
    const name = groupNameFor(rootIdOf(taskId), state.holon.contract.id);
    if (!channel) {
      await this.noChannel(engine, taskId, state, `no ${kind} channel is configured`);
      return { ok: false, reason: `no channel: ${kind}` };
    }
    const members = [...new Set([...humans.flatMap((h) => h.who), ...(this.owners[kind] ?? [])])];
    try {
      const { groupId } = await channel.createGroup({ name, members });
      engine.record(taskId, {
        kind: "system",
        event: GROUP_OPENED,
        data: { channel: kind, groupId, name, members: members.length },
      });
      return { ok: true, groupId, channel: kind, name, opened: true };
    } catch (err) {
      await this.noChannel(
        engine,
        taskId,
        state,
        `${kind} could not create the group: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, reason: `no channel: ${kind}` };
    }
  }

  /** ARCH §8.3: humans are unreachable; the holon escalates one level up, once. */
  private async noChannel(
    engine: SwarmEngine,
    taskId: string,
    state: Pick<TaskState, "holon" | "events" | "sha" | "contract">,
    reason: string,
  ): Promise<void> {
    const events = engine.loadState(taskId).events;
    if (events.some((e) => e.kind === "system" && e.event === GROUP_UNAVAILABLE)) {
      return;
    }
    engine.record(taskId, { kind: "system", event: GROUP_UNAVAILABLE, data: { reason } });
    const body = `BLOCKED: no channel. ${reason}; the humans of ${state.holon.contract.id} cannot be reached.`;
    if (state.holon.lead.kind === "human") {
      // The lead itself is unreachable: one level up is the parent (the root's upstream).
      await engine.toUpstream(
        taskId,
        state,
        { event: "BLOCKED", from: TASKMASTER, sha: state.sha, body },
        { force: true },
      );
      return;
    }
    // A human participant under an agent lead: one level up is that lead.
    await engine.notify(taskId, state, { event: "BLOCKED", body });
  }

  /**
   * An event addressed to a human (lead or participant) becomes one plain line in the
   * holon's group. Never a session run; logged as HUMAN_POSTED (or HUMAN_POST_FAILED, which
   * resume posts again).
   */
  async postToHuman(
    engine: SwarmEngine,
    taskId: string,
    state: Pick<TaskState, "holon" | "events" | "sha" | "contract">,
    msg: { to: string; from: string; event: string; sha: string; body: string; seqs: number[] },
  ): Promise<DeliveryResult> {
    const line = humanLine(msg);
    const group = await this.ensureGroup(engine, taskId, state);
    if (!group.ok) {
      engine.record(taskId, {
        kind: "send",
        event: HUMAN_POST_FAILED,
        to: msg.to,
        sha: msg.sha,
        body: line,
        data: { seqs: msg.seqs, reason: group.reason, event: msg.event, from: msg.from },
      });
      return { status: "failed", error: group.reason };
    }
    return this.postLine(engine, taskId, group, msg.to, line, {
      seqs: msg.seqs,
      event: msg.event,
      from: msg.from,
      sha: msg.sha,
    });
  }

  /** Post one line to an open group and log it. */
  async postLine(
    engine: SwarmEngine,
    taskId: string,
    group: { groupId: string; channel: string },
    to: string,
    line: string,
    meta: { seqs: number[]; event: string; from: string; sha?: string },
  ): Promise<DeliveryResult> {
    const channel = this.channels.get(group.channel);
    try {
      if (!channel) {
        throw new Error(`no ${group.channel} channel is configured`);
      }
      await channel.post(group.groupId, line);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      engine.record(taskId, {
        kind: "send",
        event: HUMAN_POST_FAILED,
        to,
        sha: meta.sha,
        body: line,
        data: { seqs: meta.seqs, reason: error, event: meta.event, from: meta.from },
      });
      return { status: "failed", error };
    }
    const rec = engine.record(taskId, {
      kind: "send",
      event: HUMAN_POSTED,
      to,
      sha: meta.sha,
      body: line,
      data: { seqs: meta.seqs, groupId: group.groupId, event: meta.event, from: meta.from },
    });
    return { status: "delivered", runId: `human-${rec.seq}` };
  }

  /** ARCH §8.1: closed when the holon is done: renamed `[done]`, then left. */
  async closeGroup(engine: SwarmEngine, taskId: string): Promise<GroupStatus> {
    const events = engine.loadState(taskId).events;
    const open = openGroupOf(events);
    if (!open) {
      return { ok: false, reason: "no open group" };
    }
    const channel = this.channels.get(open.channel);
    const name = `${open.name} [done]`;
    try {
      if (!channel) {
        throw new Error(`no ${open.channel} channel is configured`);
      }
      await channel.closeGroup(open.groupId, { name });
    } catch (err) {
      engine.record(taskId, {
        kind: "system",
        event: "GROUP_CLOSE_FAILED",
        data: { groupId: open.groupId, error: err instanceof Error ? err.message : String(err) },
      });
      return { ok: false, reason: "close failed" };
    }
    engine.record(taskId, {
      kind: "system",
      event: GROUP_CLOSED,
      data: { channel: open.channel, groupId: open.groupId, name },
    });
    return { ok: true, groupId: open.groupId, channel: open.channel, name, opened: false };
  }

  /** The open holon whose group this is, from the events of open tasks (no extra index file). */
  findHolonByGroup(engine: SwarmEngine, channel: string, groupId: string): string | undefined {
    for (const taskId of engine.openTaskIds()) {
      try {
        const open = openGroupOf(engine.loadState(taskId).events);
        if (open && open.channel === channel && open.groupId === groupId) {
          return taskId;
        }
      } catch {
        // an unreadable task never blocks another one
      }
    }
    return undefined;
  }

  /** Roles a sender speaks as in a holon: the human lead first, then participants. */
  rolesOf(holon: Pick<Holon, "lead" | "participants">, who: string): string[] {
    const me = normalizeWho(who);
    return humansOf(holon)
      .filter((h) => h.who.some((w) => normalizeWho(w) === me))
      .map((h) => h.role);
  }
}

/**
 * The root id of a task id. Child holons (ARCH §5) are addressed by path from their root;
 * a root holon's root is itself.
 */
export function rootIdOf(taskId: string): string {
  return taskId.split("/")[0] ?? taskId;
}

/** Ops (ARCH §10a house standard): open a holon's group now. CLI `swarm group open` calls this. */
export async function openHolonGroup(engine: SwarmEngine, taskId: string): Promise<GroupStatus> {
  return engine.locks.run(taskId, async () => {
    const state = engine.loadState(taskId);
    if (state.status !== "open") {
      return { ok: false, reason: `holon ${taskId} is ${state.status}` };
    }
    return engine.humans.ensureGroup(engine, taskId, state);
  });
}

/** Ops: close a holon's group (rename `[done]`, leave). CLI `swarm group close` calls this. */
export async function closeHolonGroup(engine: SwarmEngine, taskId: string): Promise<GroupStatus> {
  return engine.locks.run(taskId, () => engine.humans.closeGroup(engine, taskId));
}
