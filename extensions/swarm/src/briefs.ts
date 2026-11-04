import { parentKeyOf, type Contract } from "./contract.js";
import type { Canon, Holon, Lane } from "./holon.js";
import { ROLE_PLACEHOLDER, TASKMASTER, UPSTREAM } from "./routing.js";
import { laneRoleOf } from "./sessions.js";

// Participant briefs, sent as extraSystemPrompt on every delivery (ARCH §2, §5, §6.1).
// The v1 names are kept: the taskmaster is the holon's lead (ARCH §3.1).

function eventsFrom(contract: Contract, role: string): string[] {
  return [
    ...new Set(contract.routes.filter((r) => r.from === role || r.from === "*").map((r) => r.on)),
  ];
}

function common(contract: Contract): string[] {
  return [
    `Task: ${contract.id} (${contract.kind})`,
    `Input: ${contract.input}`,
    `Done when: ${contract.done_when}`,
    ...(contract.repo ? [`Repo: ${contract.repo}`] : []),
  ];
}

const REPEAT_RULE =
  "Every message carries a `MSG <id>` line. A message whose MSG id you already handled, or one " +
  "marked [RESEND of seq N] for work you already reported, is a repeat: do not redo the work.";

/**
 * ARCH §10b.5: a member sees only the body the lead wrote to them (no event, role, sha or route
 * note), so a member-addressed body must stand on its own as one plain line for that member.
 */
export const MEMBER_BODY_RULE =
  "- Anything you address to a member (a person or agent in the holon's channel group) reaches " +
  "them as your body alone: no event name, role, sha or note. Write that body as one plain " +
  "question or statement in everyday words, written for that member; one line, nothing else.";

export function workerBrief(contract: Contract, role: string): string {
  const canEmit = eventsFrom(contract, role);
  const commitRule =
    role === "build"
      ? "Commit your work, then emit BUILD_DONE with the new commit sha (git rev-parse HEAD)."
      : "Emit with the sha from the message you are answering.";
  return [
    `You are the ${role} worker of a swarm task. You hand work on only by calling swarm_emit.`,
    ...common(contract),
    `Events you may emit: ${canEmit.join(", ") || "BLOCKED"}.`,
    commitRule,
    "End EVERY turn by calling swarm_emit exactly once. If you cannot proceed, emit BLOCKED " +
      "with the reason. A turn that ends without swarm_emit is reported to the taskmaster.",
    REPEAT_RULE,
  ].join("\n");
}

/** ARCH §4.2: a partitioned member's own scope line from the holon's plan. */
export function partitionBrief(contract: Contract, member: string, plan: string[]): string {
  const n = Number(member.slice(member.lastIndexOf(":") + 1));
  const scope = plan[n - 1];
  const role = laneRoleOf(member);
  const base = workerBrief(contract, role);
  const lines = [
    `You are ${member}, member ${n} of the partitioned ${role} lane of a swarm task.`,
    ...(scope ? [`Your scope (only this): ${scope}`] : []),
    `Work in your own worktree on branch ${contract.id}-p${n}; commit there and emit with its sha.`,
    ...base.split("\n").slice(1),
  ];
  return lines.join("\n");
}

export function taskmasterBrief(contract: Contract): string {
  const workers = Object.keys(contract.workers).join(", ");
  const upstreamEvents = contract.routes
    .filter((r) => r.from === TASKMASTER && r.to === UPSTREAM)
    .map((r) => r.on);
  const canRetry = contract.routes.some((r) => r.from === TASKMASTER && r.to === ROLE_PLACEHOLDER);
  return [
    "You are the taskmaster of a swarm task. You own the task and report upstream.",
    ...common(contract),
    `Workers: ${workers}. They hand work to each other directly; you do not relay it.`,
    "Your duties:",
    "- On `gate passed`: check done_when, then call swarm_emit DONE with the sha and a summary.",
    ...(canRetry
      ? [
          "- On `worker X ended without exit`: re-prompt once with swarm_emit " +
            "RETRY (role: X). If told to escalate, call swarm_emit BLOCKED with the reason.",
        ]
      : []),
    "- On BLOCKED from a worker: resolve it if you can (RETRY with guidance); if someone above " +
      "you is needed, call swarm_emit BLOCKED.",
    "- On OPERATOR: that is the operator answering; act on it.",
    MEMBER_BODY_RULE,
    `Events you may emit upstream: ${upstreamEvents.join(", ")}.`,
    REPEAT_RULE,
  ].join("\n");
}

/**
 * ARCH §5: the holarchy part of a lead brief: where this holon reports (its parent lead, or
 * upstream for a root), its canon, and how it may split work into child holons.
 */
export function holarchyBrief(contract: Contract, canon: Canon | undefined): string[] {
  const parent = parentKeyOf(contract.id);
  if (!canon && !parent) {
    return [];
  }
  const lines: string[] = [""];
  if (parent) {
    lines.push(
      `This holon is a child of ${parent}. Your DONE / BLOCKED / FAILED go to its lead only ` +
        "(as CHILD_DONE / CHILD_BLOCKED / CHILD_FAILED), with a 1-5 line summary in the body; " +
        "never raw chatter. Escalate only what you cannot resolve within your canon.",
    );
  }
  if (canon) {
    const rules = [
      ...(canon.scope ? [`scope: ${canon.scope}`] : []),
      ...(canon.never.length > 0 ? [`never: ${canon.never.join(", ")}`] : []),
      ...(canon.approve.length > 0 ? [`needs your parent's yes: ${canon.approve.join(", ")}`] : []),
      `child levels allowed below this holon: ${canon.depth ?? "no limit"}`,
    ];
    lines.push(`Canon (rules from above; you may only tighten them): ${rules.join("; ")}.`);
    if (canon.depth === undefined || canon.depth > 0) {
      lines.push(
        "You may split this holon into child holons (ARCH §5) with the swarm_holon tool " +
          "(action spawn, a child holon.yaml: id, goal, done_when, lanes, optional lead and " +
          "canon). A child inherits your canon; any loosening is refused. Each child reports " +
          "to you once as CHILD_DONE / CHILD_BLOCKED / CHILD_FAILED; answer a blocked child " +
          "with swarm_holon action answer, stop one with action cancel. You cannot report " +
          "DONE while a child is still open.",
      );
    }
  }
  return lines;
}

/** ARCH §3.1/§6.1: the lead brief for a holon with lanes; names the fan-out it owns. */
export function leadBrief(contract: Contract, lanes: Lane[], opts: { canon?: Canon } = {}): string {
  const wide = lanes.filter((l) => l.count > 1);
  const holarchy = holarchyBrief(contract, opts.canon);
  if (wide.length === 0) {
    return [taskmasterBrief(contract), ...holarchy].join("\n");
  }
  const joinWord = (l: Lane) => (l.join.kind === "quorum" ? `quorum:${l.join.k}` : l.join.kind);
  const description = wide
    .map(
      (l) =>
        `${l.role}: ${l.count} members` +
        `${l.partition ? ", partitioned (own worktree each)" : ", redundant"}` +
        `, join ${joinWord(l)}`,
    )
    .join("; ");
  return [
    taskmasterBrief(contract),
    "",
    `You are the lead of this holon; its fan-out lanes are yours to drive (ARCH §3.1, §4.5).`,
    `Lanes: ${description}.`,
    "The swarm joins a lane's member events for you: you receive one merged event per lane " +
      "round, with duplicate findings folded into one list. Members are sessions " +
      "`<role>:<n>`; a member that ends without emitting is re-prompted like any worker.",
    "When a lane settles you get its merged verdict; drive the next hop yourself: emit the " +
      "same event (BUILD_DONE / AUDIT_PASS / AUDIT_FAIL / TEST_FAIL) to hand the work on, or " +
      "DONE / BLOCKED to report up.",
    "Every member verdict goes through its lane's join, whatever its route; you never see raw " +
      "member verdicts, only the lane's one result (a fail always comes to you with the " +
      "merged findings for build).",
    "- On LANE_WAITING: wait. The swarm guarantees a follow-up: the lane's result, or " +
      "LANE_STALLED.",
    "- On LANE_STALLED: decide: re-prompt the silent members (RETRY), RETRY the lane's input, " +
      "or BLOCKED up.",
    "Never end a round on NO_REPLY unless a LANE_WAITING told you a follow-up is coming.",
    ...holarchy,
  ].join("\n");
}

export function briefFor(contract: Contract, role: string): string {
  return role === TASKMASTER ? taskmasterBrief(contract) : workerBrief(contract, role);
}

/** Brief for any participant, with the holon's fan-out shape when it has one. */
export function holonBriefFor(
  holon: Pick<Holon, "contract" | "lanes"> & Partial<Pick<Holon, "canon" | "v1">>,
  plan: string[],
  member: string,
): string {
  if (member === TASKMASTER) {
    return leadBrief(holon.contract, holon.lanes, { canon: holon.v1 ? undefined : holon.canon });
  }
  const lane = holon.lanes.find((l) => l.role === laneRoleOf(member));
  if (lane?.partition && member.includes(":")) {
    return partitionBrief(holon.contract, member, plan);
  }
  return workerBrief(holon.contract, laneRoleOf(member));
}
