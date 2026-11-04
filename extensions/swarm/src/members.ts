import type { DeliveryResult } from "./delivery.js";
import type { SwarmEngine, TaskState } from "./engine.js";
import { membersOf, type Holon } from "./holon.js";
import { TASKMASTER } from "./routing.js";
import type { SwarmEvent } from "./store.js";

// Members over a channel (ARCH §3.3, §8, §10a.3, §10b). A member is whoever is on the other end
// of a channel: a person or another agent, the swarm does not care which. One channel group
// per holon that has a member lead or participant: opened on first need, closed (renamed
// `[done]`, left) when the holon is done. Events addressed to a member become one short plain
// line in that group, the sender's words only (§10b.5); the member's replies go to the holon's relay session (relay.ts).
// Agent-only holons never get a group. No person, agent, number or group id lives in code:
// members come from the holon file, the
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

export type MemberChannelsOptions = {
  /** Channel kind → group API. A kind missing here is "no channel" for that holon (§8.3). */
  channels?: Record<string, HolonChannel>;
  /** Channel kind → the root owner's channel ids (always a member of a holon's group, §8.1). */
  owners?: Record<string, string[]>;
};

/** One line of at most this many characters goes to a member (ARCH §3.3 "short"). */
export const MEMBER_LINE_MAX = 280;

export const GROUP_OPENED = "GROUP_OPENED";
export const GROUP_CLOSED = "GROUP_CLOSED";
export const GROUP_UNAVAILABLE = "GROUP_UNAVAILABLE";
export const MEMBER_POSTED = "MEMBER_POSTED";
export const MEMBER_POST_FAILED = "MEMBER_POST_FAILED";

/** `<root> · <holon id>` (ARCH §8.1). */
export function groupNameFor(rootId: string, holonId: string): string {
  return `${rootId} · ${holonId}`;
}

/**
 * ARCH §3.3, §10a.3, §10b.5: the line a member gets is the sender's own words to them, and
 * nothing else: no event name, role, sha, route note or "Needed:" suffix. The words are trimmed,
 * folded onto one line and cut at MEMBER_LINE_MAX with `…`. The event, role and sha stay in
 * events.jsonl (`swarm show`). `words` is the sender's body without the route note; a message
 * with no words of its own (a system notice) is sent as its body.
 */
export function memberLine(msg: { body: string; words?: string }): string {
  const own = msg.words?.trim() ? msg.words : msg.body;
  const line = own
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .replace(/\s+/g, " ");
  return line.length > MEMBER_LINE_MAX ? `${line.slice(0, MEMBER_LINE_MAX - 1).trimEnd()}…` : line;
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
 * Channel groups for holons with members. Lives on the engine; every frontend (CLI, method,
 * inbound hook, the fake channel) calls these same functions (ARCH §10a house standard).
 */
export class MemberChannels {
  readonly channels: Map<string, HolonChannel>;
  readonly owners: Record<string, string[]>;
  /** In-flight group work (opens, closes); tests and shutdown await it. */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(opts: MemberChannelsOptions = {}) {
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
    const members = membersOf(state.holon);
    if (members.length === 0) {
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
    const kind = members[0]!.channel;
    const channel = this.channels.get(kind);
    const name = groupNameFor(rootIdOf(taskId), state.holon.contract.id);
    if (!channel) {
      await this.noChannel(engine, taskId, state, `no ${kind} channel is configured`);
      return { ok: false, reason: `no channel: ${kind}` };
    }
    const groupMembers = [
      ...new Set([...members.flatMap((m) => m.who), ...(this.owners[kind] ?? [])]),
    ];
    try {
      const { groupId } = await channel.createGroup({ name, members: groupMembers });
      engine.record(taskId, {
        kind: "system",
        event: GROUP_OPENED,
        data: { channel: kind, groupId, name, members: groupMembers.length },
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

  /** ARCH §8.3: members are unreachable; the holon escalates one level up, once. */
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
    const body = `BLOCKED: no channel. ${reason}; the members of ${state.holon.contract.id} cannot be reached.`;
    if (state.holon.lead.kind === "member") {
      // The lead itself is unreachable: one level up is the parent (the root's upstream).
      await engine.toUpstream(
        taskId,
        state,
        { event: "BLOCKED", from: TASKMASTER, sha: state.sha, body },
        { force: true },
      );
      return;
    }
    // A member participant under an agent lead: one level up is that lead.
    await engine.notify(taskId, state, { event: "BLOCKED", body });
  }

  /**
   * An event addressed to a member (lead or participant) becomes one plain line in the
   * holon's group. Never a session run; logged as MEMBER_POSTED (or MEMBER_POST_FAILED, which
   * resume posts again).
   */
  async postToMember(
    engine: SwarmEngine,
    taskId: string,
    state: Pick<TaskState, "holon" | "events" | "sha" | "contract">,
    msg: {
      to: string;
      from: string;
      event: string;
      sha: string;
      body: string;
      words?: string;
      seqs: number[];
    },
  ): Promise<DeliveryResult> {
    const line = memberLine(msg);
    const group = await this.ensureGroup(engine, taskId, state);
    if (!group.ok) {
      engine.record(taskId, {
        kind: "send",
        event: MEMBER_POST_FAILED,
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
        event: MEMBER_POST_FAILED,
        to,
        sha: meta.sha,
        body: line,
        data: { seqs: meta.seqs, reason: error, event: meta.event, from: meta.from },
      });
      return { status: "failed", error };
    }
    const rec = engine.record(taskId, {
      kind: "send",
      event: MEMBER_POSTED,
      to,
      sha: meta.sha,
      body: line,
      data: { seqs: meta.seqs, groupId: group.groupId, event: meta.event, from: meta.from },
    });
    return { status: "delivered", runId: `member-${rec.seq}` };
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

  /** Roles a sender speaks as in a holon: the member lead first, then participants. */
  rolesOf(holon: Pick<Holon, "lead" | "participants">, who: string): string[] {
    const me = normalizeWho(who);
    return membersOf(holon)
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
    return engine.memberChannels.ensureGroup(engine, taskId, state);
  });
}

/** Ops: close a holon's group (rename `[done]`, leave). CLI `swarm group close` calls this. */
export async function closeHolonGroup(engine: SwarmEngine, taskId: string): Promise<GroupStatus> {
  return engine.locks.run(taskId, () => engine.memberChannels.closeGroup(engine, taskId));
}
