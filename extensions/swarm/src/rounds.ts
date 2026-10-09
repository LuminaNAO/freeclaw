import type { Contract } from "./contract.js";
import type { SwarmEvent } from "./store.js";

// Rounds (ARCH §12): round 1 is the original start (TASK_STARTED); every `swarm continue`
// appends ROUND_STARTED {round: n, input} to the same events.jsonl. Rounds are derived from
// the log only; nothing else is stored.

export const ROUND_STARTED = "ROUND_STARTED";

export type RoundStart = {
  round: number;
  /** Seq of TASK_STARTED (round 1) or ROUND_STARTED (round n); 0 if the log has neither. */
  seq: number;
  ts: number | null;
  input: string;
  /** Set when the follow-up replaced done_when (it stays replaced in later rounds). */
  done_when?: string;
  /** Set when the follow-up replaced budget.wall for this round only. */
  wall?: string;
};

/** ARCH §12: the one line on top of a round-n kickoff. */
export function roundLine(round: number, taskId: string): string {
  return `[round ${round} of task ${taskId}: you already hold this task's context; re-read only what changed]`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Every round of the task in log order; round 1 always comes first. */
export function roundStarts(events: SwarmEvent[]): RoundStart[] {
  const started = events.find((e) => e.event === "TASK_STARTED");
  const rounds: RoundStart[] = [
    {
      round: 1,
      seq: started?.seq ?? 0,
      ts: started?.ts ?? null,
      input: started?.body ?? "",
    },
  ];
  for (const e of events) {
    if (e.kind !== "system" || e.event !== ROUND_STARTED) {
      continue;
    }
    const round = typeof e.data?.round === "number" ? e.data.round : rounds.length + 1;
    rounds.push({
      round,
      seq: e.seq,
      ts: e.ts,
      input: str(e.data?.input) ?? e.body ?? "",
      ...(str(e.data?.done_when) && { done_when: str(e.data?.done_when) }),
      ...(str(e.data?.wall) && { wall: str(e.data?.wall) }),
    });
  }
  return rounds;
}

export function currentRound(events: SwarmEvent[]): RoundStart {
  const rounds = roundStarts(events);
  return rounds[rounds.length - 1]!;
}

/**
 * Seq after which the current round's events start: 0 in round 1 (the whole log, as before
 * §12), the ROUND_STARTED seq in round n > 1.
 */
export function currentRoundFloor(events: SwarmEvent[]): number {
  const round = currentRound(events);
  return round.round > 1 ? round.seq : 0;
}

/** The current round's events (round 1: the whole log). */
export function currentRoundEvents(events: SwarmEvent[]): SwarmEvent[] {
  const floor = currentRoundFloor(events);
  return floor === 0 ? events : events.filter((e) => e.seq >= floor);
}

/**
 * The contract as the current round sees it (ARCH §12): input is the round's input, done_when
 * is the latest replacement, budget.wall is this round's replacement. Workers, models,
 * thinking, routes, repo and upstream are the contract's, unchanged. Round 1 is the contract.
 */
export function effectiveContract(contract: Contract, events: SwarmEvent[]): Contract {
  const rounds = roundStarts(events);
  if (rounds.length === 1) {
    return contract;
  }
  const round = rounds[rounds.length - 1]!;
  const doneWhen = rounds.findLast((r) => r.done_when)?.done_when;
  return {
    ...contract,
    input: round.input,
    done_when: doneWhen ?? contract.done_when,
    budget: { ...contract.budget, wall: round.wall ?? contract.budget.wall },
  };
}
