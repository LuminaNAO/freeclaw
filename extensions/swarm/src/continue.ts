import fs from "node:fs";
import YAML from "yaml";
import { parseDuration, SwarmContractError } from "./contract.js";
import { readRepoHead, type SwarmEngine } from "./engine.js";
import { currentRound, ROUND_STARTED, roundLine } from "./rounds.js";
import { TASKMASTER, UPSTREAM } from "./routing.js";
import { updateTaskIndexEntry, type TaskStatus } from "./store.js";
import { firstRole } from "./tasks.js";

// `swarm continue <task-id> --file <followup.yaml>` (ARCH §12): a follow-up round on the same
// worker sessions. Only the new input goes out; contract, sessions, models, thinking, routes,
// repo and upstream are the task's, unchanged.

export type FollowUp = {
  input: string;
  done_when?: string;
  budget?: { wall: string };
};

const FOLLOWUP_KEYS = new Set(["input", "done_when", "budget"]);
const FOLLOWUP_BUDGET_KEYS = new Set(["wall"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SwarmContractError(`${where} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * ARCH §12 follow-up file: `input` (required), `done_when` (optional), `budget.wall`
 * (optional). Any other key is refused.
 */
export function parseFollowUp(yamlText: string): FollowUp {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch (err) {
    throw new SwarmContractError(`follow-up is not valid YAML: ${String(err)}`);
  }
  if (!isRecord(doc)) {
    throw new SwarmContractError("follow-up must be a YAML mapping");
  }
  for (const key of Object.keys(doc)) {
    if (!FOLLOWUP_KEYS.has(key)) {
      throw new SwarmContractError(
        `followup.${key} is not allowed; a follow-up has only input, done_when and budget.wall`,
      );
    }
  }
  if (doc.input === undefined || doc.input === null) {
    throw new SwarmContractError("followup.input is required");
  }
  const followUp: FollowUp = { input: nonEmpty(doc.input, "followup.input") };
  if (doc.done_when !== undefined && doc.done_when !== null) {
    followUp.done_when = nonEmpty(doc.done_when, "followup.done_when");
  }
  if (doc.budget !== undefined && doc.budget !== null) {
    if (!isRecord(doc.budget)) {
      throw new SwarmContractError("followup.budget must be a mapping { wall }");
    }
    for (const key of Object.keys(doc.budget)) {
      if (!FOLLOWUP_BUDGET_KEYS.has(key)) {
        throw new SwarmContractError(
          `followup.budget.${key} is not allowed; a follow-up has only input, done_when and budget.wall`,
        );
      }
    }
    if (doc.budget.wall !== undefined && doc.budget.wall !== null) {
      const wall = nonEmpty(doc.budget.wall, "followup.budget.wall");
      parseDuration(wall);
      followUp.budget = { wall };
    }
  }
  return followUp;
}

export type ContinuedTask = {
  taskId: string;
  id: string;
  round: number;
  status: TaskStatus;
  sha: string;
  sessions: Record<string, string>;
};

/**
 * Start round n of a task (ARCH §12). Allowed for a done task, or an open task with no active
 * run in any of its sessions; refused otherwise, with nothing written and nothing sent.
 */
export async function continueTask(
  engine: SwarmEngine,
  taskId: string,
  source: { followUpPath?: string; followUpYaml?: string },
): Promise<ContinuedTask> {
  const yaml =
    source.followUpYaml ??
    (source.followUpPath ? fs.readFileSync(source.followUpPath, "utf8") : undefined);
  if (!yaml) {
    throw new SwarmContractError("swarm.continue needs a follow-up file or follow-up text");
  }
  const followUp = parseFollowUp(yaml);

  return engine.locks.run(taskId, async () => {
    const state = engine.loadState(taskId);
    const roles = [...Object.keys(state.contract.workers), TASKMASTER];
    if (state.status === "cancelled") {
      throw new Error(`task ${taskId} is cancelled; it cannot be continued`);
    }
    if (state.status === "open") {
      const busy = roles.filter((role) => engine.mailbox.isBusy(engine.sessionKey(taskId, role)));
      if (busy.length > 0) {
        throw new Error(
          `task ${taskId} is open with an active run (${busy.join(", ")}); ` +
            `use swarm answer to reach the taskmaster instead`,
        );
      }
    } else if (state.status !== "done") {
      throw new Error(`task ${taskId} is ${state.status}; only a done or idle open task continues`);
    }

    // ARCH §3: the same sessions keep their contract model; re-apply it before any message.
    // A refused patch leaves the task exactly as it was.
    const patch = (engine.runtime.subagent as { patchSession?: unknown }).patchSession as
      | ((p: { sessionKey: string; model?: string; thinkingLevel?: string }) => Promise<unknown>)
      | undefined;
    for (const [role, spec] of Object.entries(state.contract.workers)) {
      if (!spec.model && !spec.thinking) {
        continue;
      }
      if (!patch) {
        throw new Error("runtime cannot apply worker models (patchSession unavailable)");
      }
      try {
        await patch({
          sessionKey: engine.sessionKey(taskId, role),
          ...(spec.model && { model: spec.model }),
          ...(spec.thinking && { thinkingLevel: spec.thinking }),
        });
      } catch (err) {
        throw new SwarmContractError(
          `cannot apply model to worker ${role}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const round = currentRound(state.events).round + 1;
    const sha = readRepoHead(state.contract.repo) ?? state.sha;
    const first = firstRole(state.contract.routes, Object.keys(state.contract.workers));
    // Open again first, so the round's wall deadline (armed on ROUND_STARTED) sees it open.
    updateTaskIndexEntry(engine.stateDir, taskId, { status: "open" });
    const rec = engine.record(taskId, {
      kind: "system",
      event: ROUND_STARTED,
      to: first,
      sha,
      body: followUp.input,
      data: {
        round,
        input: followUp.input,
        ...(followUp.done_when && { done_when: followUp.done_when }),
        ...(followUp.budget?.wall && { wall: followUp.budget.wall }),
      },
    });

    // The normal kickoff route, as start does, to the same session keys; only the new input.
    const roundState = engine.loadState(taskId);
    const body = `${roundLine(round, taskId)}\n${followUp.input}`;
    await engine.sendTo(taskId, roundState, {
      to: first,
      from: TASKMASTER,
      event: ROUND_STARTED,
      sha,
      body,
      seqs: [rec.seq],
    });
    await engine.sendTo(taskId, roundState, {
      to: TASKMASTER,
      from: UPSTREAM,
      event: ROUND_STARTED,
      sha,
      body,
      seqs: [rec.seq],
      salt: "kickoff",
    });

    const sessions: Record<string, string> = {};
    for (const role of roles) {
      sessions[role] = engine.sessionKey(taskId, role);
    }
    return { taskId, id: taskId, round, status: "open" as const, sha, sessions };
  });
}
