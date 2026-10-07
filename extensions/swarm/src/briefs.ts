import type { Contract } from "./contract.js";
import { ROLE_PLACEHOLDER, TASKMASTER, UPSTREAM } from "./routing.js";

// Participant briefs, sent as extraSystemPrompt on every delivery (ARCH §2, §5).

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

export function briefFor(contract: Contract, role: string): string {
  return role === TASKMASTER ? taskmasterBrief(contract) : workerBrief(contract, role);
}
