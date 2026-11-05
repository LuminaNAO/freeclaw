// Focus ops (docs/design/focus-mode.md §7.4): one function behind the chat command
// `/focus`, the CLI `openclaw gateway focus` and the gateway method `focus` (house
// rule: CLI, chat and tool call the same function). Each caller checks authority
// (§4: operator only); this module only acts and reports.
//
// The report is the same JSON on every surface (`--json`, the method response, the
// agent tool) and the same text lines (chat reply, CLI output).
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { normalizeMainKey, toAgentStoreSessionKey } from "../routing/session-key.js";
import {
  clearAllFocus,
  clearSessionFocus,
  DEFAULT_FOCUS_TIER,
  FOCUS_TIERS,
  type FocusSessionEntry,
  type FocusStatus,
  type FocusTier,
  focusTierRank,
  formatFocusStatusLines,
  parseFocusTier,
  readFocusStatus,
  setSessionFocus,
  validateFocusTarget,
} from "./focus-mode.js";

/** The store key for a target given as typed (`main`, a short key, or a full agent key). */
export function normalizeFocusTarget(cfg: OpenClawConfig, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "global") {
    return lowered;
  }
  const agentId = resolveDefaultAgentId(cfg);
  const storeKey = toAgentStoreSessionKey({
    agentId,
    requestKey: trimmed,
    mainKey: normalizeMainKey(cfg.session?.mainKey),
  }).toLowerCase();
  const parsedAgent = storeKey.split(":")[1] ?? agentId;
  return canonicalizeMainSessionAlias({
    cfg,
    agentId: parsedAgent,
    sessionKey: storeKey,
  });
}

/** Tiers a session can be set to (`none` is `off`). */
export const SETTABLE_FOCUS_TIERS: FocusTier[] = FOCUS_TIERS.filter(
  (tier) => focusTierRank(tier) > 0,
);

/** §7.4: an unknown tier is an error, so a typo never silently means `normal`. */
export function parseSettableFocusTier(raw: string | undefined): FocusTier {
  if (raw === undefined || !raw.trim()) {
    return DEFAULT_FOCUS_TIER;
  }
  const tier = parseFocusTier(raw);
  if (!tier || focusTierRank(tier) <= 0) {
    throw new Error(`unknown focus tier "${raw.trim()}" (use ${SETTABLE_FOCUS_TIERS.join("|")})`);
  }
  return tier;
}

export type FocusOpRequest =
  | { action: "status" }
  | { action: "set"; target: string; tier?: string }
  /** `target` omitted, or `all: true`: clear all focus. */
  | { action: "off"; target?: string; all?: boolean };

/** The one result shape every surface returns (`--json`, method, tool). */
export type FocusReport = {
  action: "status" | "set" | "off";
  /** set / off <key>: the stored session key; off (all): null; status: null. */
  sessionKey: string | null;
  /** set: the new tier; off <key>: `none`; otherwise null. */
  tier: FocusTier | null;
  /** set / off <key>: the tier the session held before (`none` when it held none). */
  previousTier: FocusTier | null;
  /** off: the entries that were cleared, by session key. */
  ended: Record<string, FocusSessionEntry>;
  /** Sessions now allowed whose waiting prompts are being replayed (§7.3). */
  replaying: number;
  /** The state after the op (active level, focused sessions, waiting per session). */
  status: FocusStatus;
};

export type FocusOpResult = { report: FocusReport; done: Promise<void> };

/** §7.4: the one ops function. Throws on a bad target or tier (nothing changes). */
export function runFocusOp(params: {
  cfg: OpenClawConfig;
  request: FocusOpRequest;
  /** Who acts: operator sender id, client id or "cli". */
  by: string;
}): FocusOpResult {
  const { cfg, request, by } = params;
  const base = {
    sessionKey: null,
    tier: null,
    previousTier: null,
    ended: {},
    replaying: 0,
  };
  if (request.action === "status") {
    return {
      report: { action: "status", ...base, status: readFocusStatus() },
      done: Promise.resolve(),
    };
  }
  if (request.action === "off") {
    const raw = request.all ? "" : (request.target?.trim() ?? "");
    if (!raw) {
      const { ended, replaying, done } = clearAllFocus();
      return {
        report: {
          action: "off",
          ...base,
          ended,
          replaying,
          status: readFocusStatus(),
        },
        done,
      };
    }
    const sessionKey = normalizeFocusTarget(cfg, raw);
    const { ended, replaying, done } = clearSessionFocus(sessionKey);
    return {
      report: {
        action: "off",
        ...base,
        sessionKey,
        tier: "none",
        previousTier: ended?.tier ?? "none",
        ended: ended ? { [sessionKey]: ended } : {},
        replaying,
        status: readFocusStatus(),
      },
      done,
    };
  }
  const tier = parseSettableFocusTier(request.tier);
  const target = normalizeFocusTarget(cfg, request.target ?? "");
  const error = validateFocusTarget(target);
  if (error) {
    throw new Error(error);
  }
  const result = setSessionFocus({ sessionKey: target, tier, by });
  return {
    report: {
      action: "set",
      ...base,
      sessionKey: result.sessionKey,
      tier: result.entry?.tier ?? "none",
      previousTier: result.previous?.tier ?? "none",
      replaying: result.replaying,
      status: readFocusStatus(),
    },
    done: result.done,
  };
}

function replayLine(replaying: number): string | undefined {
  return replaying > 0
    ? `Replaying waiting messages for ${replaying} session(s), one combined prompt each.`
    : undefined;
}

/** The text every surface prints for a report (chat reply, CLI output). */
export function formatFocusReportLines(report: FocusReport): string[] {
  if (report.action === "status") {
    return formatFocusStatusLines(report.status);
  }
  const lines: string[] = [];
  if (report.action === "set") {
    lines.push(
      report.previousTier === report.tier
        ? `Focus: ${report.sessionKey} stays at ${report.tier}.`
        : `Focus: ${report.sessionKey} set to ${report.tier}.`,
    );
  } else if (report.sessionKey) {
    lines.push(
      report.previousTier === "none"
        ? `Focus: ${report.sessionKey} was not focused.`
        : `Focus: ${report.sessionKey} back to none.`,
    );
  } else {
    const count = Object.keys(report.ended).length;
    lines.push(count > 0 ? `Focus off: cleared ${count} session(s).` : "Focus is already off.");
  }
  const replay = replayLine(report.replaying);
  if (replay) {
    lines.push(replay);
  }
  if (report.status.sessions.length > 0) {
    lines.push(`Active level: ${report.status.active}.`);
  }
  return lines;
}

/** Usage shared by the chat command and the method's errors (§7.4). */
export const FOCUS_USAGE =
  "Usage: /focus | /focus here|<session key> [normal|hyper] | /focus off here|<session key> | /focus off";

/**
 * Parse the chat arguments of `/focus` (§7.4) into a request. `here` is the session
 * the command is sent from. Throws with the usage on a malformed command.
 */
export function parseFocusCommandArgs(raw: string, hereSessionKey: string): FocusOpRequest {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { action: "status" };
  }
  const resolveTarget = (token: string) => {
    if (token.toLowerCase() !== "here") {
      return token;
    }
    if (!hereSessionKey.trim()) {
      throw new Error("this chat has no session key; name the session");
    }
    return hereSessionKey;
  };
  const [first, ...rest] = tokens;
  const head = first.toLowerCase();
  if (head === "status" && rest.length === 0) {
    return { action: "status" };
  }
  if (head === "off") {
    if (rest.length === 0) {
      return { action: "off", all: true };
    }
    if (rest.length === 1) {
      return { action: "off", target: resolveTarget(rest[0]) };
    }
    throw new Error(FOCUS_USAGE);
  }
  if (rest.length > 1) {
    throw new Error(FOCUS_USAGE);
  }
  return { action: "set", target: resolveTarget(first), tier: rest[0] };
}
