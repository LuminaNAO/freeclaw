// The Focus section of the system prompt (docs/design/focus-mode.md §7.5).
// Every new session learns what focus is, the tiers, the §7.2 rule, the commands
// and that only an operator sets it. When focus is on, one more line gives the
// active level and this session's tier. Five lines at most under the heading.

/** Upper bound on the section body (lines under `## Focus`, state line included). */
export const FOCUS_PROMPT_MAX_LINES = 5;
/** Upper bound on the whole section in characters (heading and state line included). */
export const FOCUS_PROMPT_MAX_CHARS = 1100;

export const FOCUS_PROMPT_HEADING = "## Focus";

/** What the section says about the current state (tiers as in FOCUS_TIERS). */
export type FocusPromptState = {
  /** §7.2 active level: the highest tier any session holds (`none` when no focus). */
  active: string;
  /** This session's tier (`none` when not focused). */
  tier: string;
};

const FOCUS_PROMPT_RULES = [
  "Focus decides which sessions run. Tiers: none < normal < hyper; the active level is the highest tier any session holds.",
  "A person's message to a session runs only if its tier >= the active level; otherwise it waits on disk, the sender gets one busy notice, and it is replayed as one combined prompt when that session is allowed again. Cron, heartbeat, subagent, announce and swarm turns never wait.",
  "Commands: /focus (status), /focus here|<session key> [normal|hyper], /focus off here|<session key>, /focus off (clear all). Same as `openclaw gateway focus` and gateway action=focus.",
  "Only an operator can set or clear focus; use it only when an operator asks.",
];

function stateLine(state: FocusPromptState): string {
  const focused = state.tier !== "none";
  const runs = rank(state.tier) >= rank(state.active);
  const self = focused ? `this session is focused at ${state.tier}` : "this session is not focused";
  return `Focus is on: active level ${state.active}; ${self}, so its people's messages ${runs ? "run" : "wait"}.`;
}

// Order of the tiers as the prompt names them; an unknown tier ranks with `none`.
const PROMPT_TIER_ORDER = ["none", "normal", "hyper"];

function rank(tier: string): number {
  return Math.max(0, PROMPT_TIER_ORDER.indexOf(tier));
}

/**
 * §7.5: the Focus section lines (heading, rules, optional state line, blank line).
 * `state` is given only when the gateway has focus state (an active level above none).
 */
export function buildFocusPromptSection(state?: FocusPromptState): string[] {
  const body = [...FOCUS_PROMPT_RULES];
  if (state && state.active !== "none") {
    body.push(stateLine(state));
  }
  return [FOCUS_PROMPT_HEADING, ...body.slice(0, FOCUS_PROMPT_MAX_LINES), ""];
}
