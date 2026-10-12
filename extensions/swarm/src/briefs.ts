import type { Contract } from "./contract.js";
import type { Holon, Lane } from "./holon.js";
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
    "- On BLOCKED from a worker: resolve it if you can (RETRY with guidance); if a human is " +
      "needed, call swarm_emit BLOCKED.",
    "- On OPERATOR: that is the operator answering; act on it.",
    `Events you may emit upstream: ${upstreamEvents.join(", ")}.`,
    REPEAT_RULE,
  ].join("\n");
}

/** ARCH §3.1/§6.1: the lead brief for a holon with lanes; names the fan-out it owns. */
export function leadBrief(contract: Contract, lanes: Lane[]): string {
  const wide = lanes.filter((l) => l.count > 1);
  if (wide.length === 0) {
    return taskmasterBrief(contract);
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
  ].join("\n");
}

export function briefFor(contract: Contract, role: string): string {
  return role === TASKMASTER ? taskmasterBrief(contract) : workerBrief(contract, role);
}

/** Brief for any participant, with the holon's fan-out shape when it has one. */
export function holonBriefFor(
  holon: Pick<Holon, "contract" | "lanes">,
  plan: string[],
  member: string,
): string {
  if (member === TASKMASTER) {
    return leadBrief(holon.contract, holon.lanes);
  }
  const lane = holon.lanes.find((l) => l.role === laneRoleOf(member));
  if (lane?.partition && member.includes(":")) {
    return partitionBrief(holon.contract, member, plan);
  }
  return workerBrief(holon.contract, laneRoleOf(member));
}
