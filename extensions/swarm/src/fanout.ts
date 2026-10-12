import type { Join, Lane } from "./holon.js";
import type { SwarmEvent } from "./store.js";

// Fan-out joins (ARCH §4.4, §4.5): the lead joins a lane's results from the members' events;
// there is no join service. State is derived from the log per (lane, event) round.

export type LaneRound = {
  /** Emit seqs of the lane's members in this round (all emits of the given event by lane members). */
  members: Map<string, SwarmEvent>;
};

/** Emits of `event` by members of a lane since (strictly after) `floor` seq. */
export function laneEmits(
  events: SwarmEvent[],
  lane: Lane,
  event: string,
  floor = 0,
): SwarmEvent[] {
  const re = new RegExp(`^${lane.role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[1-9]\\d*$`);
  return events.filter(
    (e) =>
      e.kind === "emit" &&
      e.event === event &&
      e.seq > floor &&
      e.from !== undefined &&
      re.test(e.from),
  );
}

export type JoinOutcome =
  | { settled: false; reason: string }
  | { settled: true; outcome: "pass"; event: SwarmEvent }
  | { settled: true; outcome: "fail"; findings: string; dissenters: string[] }
  | { settled: true; outcome: "cancel-rest"; winner: SwarmEvent };

/**
 * Is this lane's round of `event` settled, and how? Pure function of the log + the lane's join.
 * - all: every member emitted; pass when every emit is the pass event.
 * - quorum:k: k members emitted the pass event → pass; more than count-k emitted the fail
 *   event → fail (k passes are no longer reachable).
 * - any: the first pass settles it; the rest are told to stop (ARCH §4.4).
 */
export function joinStatus(
  lane: Lane,
  emits: SwarmEvent[],
  passEvent: string,
  failEvent: string,
): JoinOutcome {
  const passes = emits.filter((e) => e.event === passEvent);
  const fails = emits.filter((e) => e.event === failEvent);
  switch (lane.join.kind) {
    case "any": {
      const winner = passes[0];
      if (winner) {
        return { settled: true, outcome: "cancel-rest", winner };
      }
      if (fails.length >= lane.count) {
        return {
          settled: true,
          outcome: "fail",
          findings: dedupeFindings(emits.map((e) => e.body ?? "")),
          dissenters: fails.map((e) => e.from ?? ""),
        };
      }
      return { settled: false, reason: `any: waiting for the first ${passEvent}` };
    }
    case "quorum": {
      const k = lane.join.k;
      if (passes.length >= k) {
        return { settled: true, outcome: "pass", event: passes[k - 1]! };
      }
      if (fails.length > lane.count - k) {
        // §4.4: build receives one deduplicated list — the dissent plus any finding a
        // passing member raised in passing.
        return {
          settled: true,
          outcome: "fail",
          findings: dedupeFindings(emits.map((e) => e.body ?? "")),
          dissenters: fails.map((e) => e.from ?? ""),
        };
      }
      return {
        settled: false,
        reason: `quorum:${k}: ${passes.length} pass, ${fails.length} fail of ${lane.count}`,
      };
    }
    case "all": {
      if (emits.length < lane.count) {
        return {
          settled: false,
          reason: `all: ${emits.length}/${lane.count} members reported`,
        };
      }
      if (fails.length > 0) {
        return {
          settled: true,
          outcome: "fail",
          findings: dedupeFindings(emits.map((e) => e.body ?? "")),
          dissenters: fails.map((e) => e.from ?? ""),
        };
      }
      return { settled: true, outcome: "pass", event: passes[0]! };
    }
  }
}

const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * Findings dedup (ARCH §4.4): build receives one list. Findings are bullet/numbered lines in
 * member bodies; two findings are the same when their normalized text (lowercase, no
 * punctuation or extra spaces) matches. The first report of a finding keeps its place.
 */
export function dedupeFindings(bodies: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      const finding = text.replace(BULLET_RE, "");
      const key = finding
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(text);
    }
  }
  return out.join("\n");
}
