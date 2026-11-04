import type { RunEnd } from "./delivery.js";
import {
  modelMismatchFor,
  type EmitInput,
  type EmitResult,
  type SwarmEngine,
  type TaskState,
} from "./engine.js";
import { membersOf, RELAY_ROLE, type Holon } from "./holon.js";
import { MEMBER_POST_FAILED, MEMBER_POSTED, openGroupOf } from "./members.js";
import { ROLE_PLACEHOLDER, resolveRoute, TASKMASTER } from "./routing.js";
import type { SwarmEvent } from "./store.js";

// The relay (ARCH §3.3, §10a.3): one small session per holon with members. It reads each member
// reply in the holon's group and emits exactly one routed event for it, then confirms back in
// one line what it understood. Unclear → it asks once. It never decides on its own and has no
// tools except swarm_emit (the confirmation and the question are the emit's body, posted to
// the group by the engine). Every frontend (the channel's inbound hook, the fake channel, the
// `swarm relay` CLI verb) calls `relayMemberReply`; the relay session's swarm_emit calls
// `relayEmit`.

export const MEMBER_REPLY = "MEMBER_REPLY";
export const MEMBER_IGNORED = "MEMBER_IGNORED";
export const RELAY_ROUTED = "RELAY_ROUTED";
export const RELAY_ASKED = "RELAY_ASKED";
export const RELAY_REFUSED = "RELAY_REFUSED";
export const RELAY_SILENT = "RELAY_SILENT";
/** The relay's "I need to ask" event: posted to the group, never routed. */
export const ASK = "ASK";

export type RelayReplyResult =
  | { ok: true; taskId: string; role: string; seq: number; delivery: string }
  | { ok: false; reason: string };

/** The relay's own session model: canon.relay, else the lead model (agent lead), else default. */
export function relayModelOf(holon: Pick<Holon, "canon" | "lead">): {
  model?: string;
  thinking?: string;
} {
  return {
    model: holon.canon.relay?.model ?? holon.lead.model,
    thinking: holon.canon.relay?.thinking ?? holon.lead.thinking,
  };
}

/** Member replies the relay has not answered yet, oldest first. */
export function pendingReplies(events: SwarmEvent[]): SwarmEvent[] {
  const lastAction = events.findLast(
    (e) => e.kind === "system" && (e.event === RELAY_ROUTED || e.event === RELAY_ASKED),
  );
  return events.filter(
    (e) => e.kind === "system" && e.event === MEMBER_REPLY && e.seq > (lastAction?.seq ?? 0),
  );
}

/** True when the relay's last action was a question (it may not ask again, §3.3). */
function askedLast(events: SwarmEvent[]): boolean {
  const lastAction = events.findLast(
    (e) => e.kind === "system" && (e.event === RELAY_ROUTED || e.event === RELAY_ASKED),
  );
  return lastAction?.event === RELAY_ASKED;
}

/** The last line the swarm posted to a member role: what the member is answering. */
function lastPostTo(events: SwarmEvent[], role: string): SwarmEvent | undefined {
  return events.findLast((e) => e.kind === "send" && e.event === MEMBER_POSTED && e.to === role);
}

/** The events a member role may speak, from the holon's routes (for the relay brief). */
export function eventsForRole(holon: Pick<Holon, "contract">, role: string): string[] {
  return [
    ...new Set(
      holon.contract.routes.filter((r) => r.from === role || r.from === "*").map((r) => r.on),
    ),
  ];
}

export function relayBrief(holon: Pick<Holon, "contract" | "lead" | "participants">): string {
  const members = membersOf(holon)
    .map((m) => {
      const as = m.role === TASKMASTER ? "the lead" : `the ${m.role} participant`;
      return `- ${as} (role ${m.role}) may say: ${eventsForRole(holon, m.role).join(", ") || "BLOCKED"}`;
    })
    .join("\n");
  return [
    `You are the relay of swarm holon ${holon.contract.id}. Members answer the holon in plain chat;`,
    "you turn each reply into exactly one swarm event. You never decide anything yourself.",
    "A member may be a person or another agent; treat every member the same way.",
    `Goal of the holon: ${holon.contract.input}`,
    "Members in this holon:",
    members,
    "For every message (it shows the line the member was answering and their reply):",
    "- If the reply clearly means one of the events above, call swarm_emit once with that",
    "  event, the sha from the message, and as body ONE short line saying what you understood",
    '  (e.g. "Approved the plan; build goes on."). For APPROVED or RETRY set `role` to the',
    "  role being answered (shown in the message) when it is not obvious.",
    `- If it is unclear, call swarm_emit once with event ${ASK} and as body ONE short question.`,
    "  You may ask only once; after an answer to your question, pick the closest event, or",
    "  BLOCKED with the member's words.",
    "- Never invent an instruction the member did not give. Never call any other tool.",
    "End EVERY turn with exactly one swarm_emit.",
  ].join("\n");
}

/**
 * A member wrote in a holon's group (ARCH §3.3). The reply is logged and handed to the relay
 * session (queued behind its current turn, principle 4). Messages from people who are not a
 * member of the holon are logged as ignored and never reach the relay.
 */
export async function relayMemberReply(
  engine: SwarmEngine,
  msg:
    | { channel: string; groupId: string; who: string; text: string }
    | { taskId: string; who: string; text: string },
): Promise<RelayReplyResult> {
  const taskId =
    "taskId" in msg
      ? msg.taskId
      : engine.memberChannels.findHolonByGroup(engine, msg.channel, msg.groupId);
  if (!taskId) {
    return { ok: false, reason: "not a swarm group" };
  }
  if (!engine.openTaskIds().includes(taskId)) {
    return { ok: false, reason: `holon ${taskId} is not open` };
  }
  const text = msg.text.trim();
  return engine.locks.run(taskId, async () => {
    const state = engine.loadState(taskId);
    if (state.status !== "open") {
      return { ok: false, reason: `holon ${taskId} is ${state.status}` };
    }
    const role = engine.memberChannels.rolesOf(state.holon, msg.who)[0];
    if (!role || !text) {
      engine.record(taskId, {
        kind: "system",
        event: MEMBER_IGNORED,
        data: { reason: role ? "empty" : "not a member of this holon" },
      });
      return { ok: false, reason: role ? "empty message" : "sender is not a member of this holon" };
    }
    const rec = engine.record(taskId, {
      kind: "system",
      event: MEMBER_REPLY,
      from: role,
      to: RELAY_ROLE,
      sha: state.sha,
      body: text,
    });
    const answering = lastPostTo(state.events, role);
    await applyRelayModel(engine, taskId, state);
    const result = await engine.sendTo(taskId, state, {
      to: RELAY_ROLE,
      from: role,
      event: MEMBER_REPLY,
      sha: state.sha,
      body: [
        `Speaker: ${role === TASKMASTER ? "the lead" : role} (role ${role})`,
        ...(answering
          ? [
              `Answering: ${answering.body ?? ""}`,
              `That line came from role ${String(answering.data?.from ?? "?")}.`,
              // ARCH §10b.5: the member saw only the words; the event behind them is here.
              ...(answering.data?.event
                ? [`It carried event ${String(answering.data.event)} @ ${answering.sha ?? "?"}.`]
                : []),
            ]
          : ["Answering: nothing yet (the member wrote first)"]),
        `Reply: ${text}`,
        ...(askedLast(state.events) ? ["You already asked once: do not ask again."] : []),
      ].join("\n"),
      seqs: [rec.seq],
      extraSystemPrompt: relayBrief(state.holon),
    });
    return { ok: true, taskId, role, seq: rec.seq, delivery: result.status };
  });
}

async function applyRelayModel(engine: SwarmEngine, taskId: string, state: TaskState) {
  const { model, thinking } = relayModelOf(state.holon);
  if (
    (!model && !thinking) ||
    state.events.some((e) => e.event === "MODEL_APPLIED" && e.from === RELAY_ROLE)
  ) {
    return;
  }
  const patch = (engine.runtime.subagent as { patchSession?: unknown }).patchSession as
    | ((p: {
        sessionKey: string;
        model?: string;
        thinkingLevel?: string;
        label?: string;
      }) => Promise<{ provider: string; model: string }>)
    | undefined;
  if (!patch) {
    return;
  }
  try {
    const resolved = await patch({
      sessionKey: engine.sessionKey(taskId, RELAY_ROLE),
      label: `swarm:${taskId}:${RELAY_ROLE}`,
      ...(model && { model }),
      ...(thinking && { thinkingLevel: thinking }),
    });
    engine.record(taskId, {
      kind: "system",
      event: "MODEL_APPLIED",
      from: RELAY_ROLE,
      data: { model, thinking, resolved: `${resolved.provider}/${resolved.model}` },
    });
  } catch (err) {
    engine.record(taskId, {
      kind: "system",
      event: "MODEL_REAPPLY_FAILED",
      from: RELAY_ROLE,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * The relay session called swarm_emit (ARCH §10a.3). Exactly one routed event per member
 * reply: an emit with no unanswered reply is refused; ASK is posted to the group (once); any
 * other event is routed as the member's own (from the member's role), and the relay's one-line
 * confirmation goes back to the group.
 */
export async function relayEmit(
  engine: SwarmEngine,
  taskId: string,
  input: EmitInput,
): Promise<EmitResult> {
  return engine.locks.run(taskId, async () => {
    let state: TaskState;
    try {
      state = engine.loadState(taskId);
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
    if (state.status !== "open") {
      return { ok: false, error: `task ${taskId} is ${state.status}; not open for events` };
    }
    const wrongModel = modelMismatchFor(state.events, RELAY_ROLE);
    if (wrongModel) {
      // ARCH §3: the relay is a participant like any other; never routed off its model.
      return {
        ok: false,
        error: `refused: the relay ran on ${wrongModel.observed}, not ${wrongModel.expected}`,
      };
    }
    const event = input.event.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(event)) {
      return { ok: false, error: `invalid event name "${input.event}"` };
    }
    const pending = pendingReplies(state.events);
    const reply = pending.at(-1);
    if (!reply?.from) {
      engine.record(taskId, {
        kind: "system",
        event: RELAY_REFUSED,
        from: RELAY_ROLE,
        data: { event, reason: "no unanswered member reply" },
      });
      return {
        ok: false,
        error: "refused: every member reply already has its one event; wait for the next reply",
      };
    }
    const role = reply.from;
    const group = openGroupOf(state.events);
    const confirm = firstLine(input.body);
    if (event === ASK) {
      if (askedLast(state.events)) {
        return {
          ok: false,
          error:
            "refused: you already asked once; emit the closest event, or BLOCKED with the member's words",
        };
      }
      const rec = engine.record(taskId, {
        kind: "system",
        event: RELAY_ASKED,
        from: RELAY_ROLE,
        to: role,
        body: confirm,
        data: { reply: reply.seq },
      });
      if (group) {
        await engine.memberChannels.postLine(engine, taskId, group, role, `Question: ${confirm}`, {
          seqs: [rec.seq],
          event: ASK,
          from: RELAY_ROLE,
        });
      }
      return { ok: true, seq: rec.seq, routedTo: role, notice: "question posted to the group" };
    }
    // APPROVED / RETRY answer the role whose line the member was answering, unless named.
    let target = input.role;
    const route = resolveRoute(state.contract.routes, { event, from: role });
    if (!target && route?.to === ROLE_PLACEHOLDER) {
      const answering = lastPostTo(state.events, role);
      const from = typeof answering?.data?.from === "string" ? answering.data.from : undefined;
      target = from && state.contract.workers[from.replace(/:\d+$/, "")] ? from : undefined;
    }
    const words = pending.map((p) => p.body ?? "").join("\n");
    // Marked before routing, so a terminal event that closes the holon (DONE) still counts.
    const marker = engine.record(taskId, {
      kind: "system",
      event: RELAY_ROUTED,
      from: RELAY_ROLE,
      to: role,
      body: confirm,
      data: { reply: reply.seq, event },
    });
    if (group && confirm) {
      await engine.memberChannels.postLine(engine, taskId, group, role, `Understood: ${confirm}`, {
        seqs: [marker.seq],
        event,
        from: RELAY_ROLE,
      });
    }
    const result = await engine.emitAsMember(taskId, role, {
      event,
      sha: input.sha || state.sha,
      body: `${words}\n(relay: ${confirm})`.trim(),
      ...(target && { role: target.replace(/:\d+$/, "") }),
    });
    if (!result.ok) {
      // Nothing was routed: the reply is open again so the relay can fix its emit.
      engine.record(taskId, {
        kind: "system",
        event: RELAY_REFUSED,
        from: RELAY_ROLE,
        data: { event, reason: result.error },
      });
      engine.record(taskId, {
        kind: "system",
        event: MEMBER_REPLY,
        from: role,
        to: RELAY_ROLE,
        sha: reply.sha,
        body: words,
        data: { reopened: reply.seq },
      });
    }
    return result;
  });
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l) ?? ""
  ).slice(0, 240);
}

/**
 * Exit enforcement for the relay (ARCH §6.3): a relay turn that ends with a reply still
 * unanswered is re-prompted once; a second silent turn reports BLOCKED from the member's role
 * with the member's own words, so nothing goes quiet.
 */
export async function onRelayRunEnd(engine: SwarmEngine, taskId: string, end: RunEnd) {
  if (end.status === "aborted") {
    return;
  }
  await engine.locks.run(taskId, async () => {
    let state: TaskState;
    try {
      state = engine.loadState(taskId);
    } catch {
      return;
    }
    const pending = pendingReplies(state.events);
    const reply = pending.at(-1);
    if (state.status !== "open" || !reply?.from) {
      return;
    }
    if (engine.mailbox.hasPending(engine.sessionKey(taskId, RELAY_ROLE))) {
      return; // a newer reply is queued for the relay's next turn
    }
    const silent = state.events.filter(
      (e) => e.event === RELAY_SILENT && e.seq > (pending[0]?.seq ?? 0),
    ).length;
    engine.record(taskId, {
      kind: "system",
      event: RELAY_SILENT,
      from: RELAY_ROLE,
      data: { reply: reply.seq, status: end.status },
    });
    if (silent === 0) {
      await engine.sendTo(taskId, state, {
        to: RELAY_ROLE,
        from: "swarm",
        event: "RETRY",
        sha: state.sha,
        body:
          "Your turn ended without swarm_emit. Turn the member's reply into exactly one event " +
          `(or ${ASK} once), now.\nReply: ${pending.map((p) => p.body ?? "").join("\n")}`,
        seqs: [reply.seq],
        salt: `relay-retry-${reply.seq}`,
        extraSystemPrompt: relayBrief(state.holon),
      });
      return;
    }
    const words = pending.map((p) => p.body ?? "").join("\n");
    engine.record(taskId, {
      kind: "system",
      event: RELAY_ROUTED,
      from: RELAY_ROLE,
      to: reply.from,
      data: { reply: reply.seq, event: "BLOCKED", escalated: true },
    });
    const body = `the relay could not turn a member reply into an event; the member said: ${words}`;
    const route = resolveRoute(state.contract.routes, { event: "BLOCKED", from: reply.from });
    if (route) {
      await engine.emitAsMember(taskId, reply.from, { event: "BLOCKED", sha: state.sha, body });
    } else {
      await engine.notify(taskId, state, { event: "BLOCKED", body });
    }
  });
}

/**
 * Resume (ARCH §7) for the member side of a holon: lines that could not be posted are posted
 * again, and a member reply left unanswered with nothing queued for the relay goes to it again.
 */
export async function resumeMembers(
  engine: SwarmEngine,
  taskId: string,
): Promise<{ reposted: number; relayed: number }> {
  const out = { reposted: 0, relayed: 0 };
  const state = engine.loadState(taskId);
  if (state.status !== "open" || membersOf(state.holon).length === 0) {
    return out;
  }
  const posted = new Set(
    state.events
      .filter((e) => e.kind === "send" && e.event === MEMBER_POSTED)
      .map((e) => `${e.to}|${JSON.stringify(e.data?.seqs ?? [])}`),
  );
  const failed = new Map<string, SwarmEvent>();
  for (const e of state.events) {
    if (e.kind === "send" && e.event === MEMBER_POST_FAILED) {
      const key = `${e.to}|${JSON.stringify(e.data?.seqs ?? [])}`;
      if (!posted.has(key)) {
        failed.set(key, e);
      }
    }
  }
  for (const e of failed.values()) {
    const seqs = Array.isArray(e.data?.seqs) ? (e.data.seqs as number[]) : [];
    const group = await engine.memberChannels.ensureGroup(engine, taskId, state);
    if (!group.ok || !e.to) {
      break;
    }
    const res = await engine.memberChannels.postLine(engine, taskId, group, e.to, e.body ?? "", {
      seqs,
      event: String(e.data?.event ?? "RESEND"),
      from: String(e.data?.from ?? "swarm"),
      sha: e.sha,
    });
    if (res.status === "delivered") {
      out.reposted += 1;
    }
  }
  const pending = pendingReplies(state.events);
  const relayKey = engine.sessionKey(taskId, RELAY_ROLE);
  const reply = pending.at(-1);
  if (reply?.from && !engine.mailbox.isBusy(relayKey) && !engine.mailbox.hasPending(relayKey)) {
    const result = await engine.sendTo(taskId, state, {
      to: RELAY_ROLE,
      from: reply.from,
      event: MEMBER_REPLY,
      sha: state.sha,
      body: [
        "[gateway restarted before you answered this reply]",
        `Speaker: ${reply.from === TASKMASTER ? "the lead" : reply.from} (role ${reply.from})`,
        `Reply: ${pending.map((p) => p.body ?? "").join("\n")}`,
      ].join("\n"),
      seqs: [reply.seq],
      salt: `relay-resume-${state.events.at(-1)?.seq ?? 0}`,
      extraSystemPrompt: relayBrief(state.holon),
    });
    if (result.status !== "failed") {
      out.relayed += 1;
    }
  }
  return out;
}

/** Wire the relay into an engine: the relay session's swarm_emit lands here. */
export function attachRelay(engine: SwarmEngine): void {
  engine.relayEmitHandler = (taskId, input) => relayEmit(engine, taskId, input);
}
