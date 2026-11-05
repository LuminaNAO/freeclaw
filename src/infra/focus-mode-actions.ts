// Focus mode actions shared by the chat command, the CLI and the gateway method
// (docs/design/focus-mode.md §4, §7.4: one ops function behind all three).
// Authority is checked by each caller.
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { normalizeMainKey, toAgentStoreSessionKey } from "../routing/session-key.js";
import {
  clearAllFocus,
  clearSessionFocus,
  type FocusSessionEntry,
  type FocusStatus,
  type FocusTier,
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
  return canonicalizeMainSessionAlias({ cfg, agentId: parsedAgent, sessionKey: storeKey });
}

export type FocusActionResult =
  | {
      action: "set";
      sessionKey: string;
      entry: FocusSessionEntry | undefined;
      previous: FocusSessionEntry | undefined;
      replaying: number;
      done: Promise<void>;
    }
  | {
      action: "off";
      /** The one session cleared, or undefined when all focus was cleared. */
      sessionKey: string | undefined;
      ended: Record<string, FocusSessionEntry>;
      replaying: number;
      done: Promise<void>;
    }
  | { action: "status"; status: FocusStatus };

export function runFocusAction(params: {
  cfg: OpenClawConfig;
  action: "set" | "off" | "status";
  /** set: the session; off: the one session (all focus when omitted). */
  target?: string;
  tier?: FocusTier;
  by: string;
}): FocusActionResult {
  if (params.action === "status") {
    return { action: "status", status: readFocusStatus() };
  }
  if (params.action === "off") {
    if (!params.target?.trim()) {
      const { ended, replaying, done } = clearAllFocus();
      return { action: "off", sessionKey: undefined, ended, replaying, done };
    }
    const sessionKey = normalizeFocusTarget(params.cfg, params.target);
    const { ended, replaying, done } = clearSessionFocus(sessionKey);
    return {
      action: "off",
      sessionKey,
      ended: ended ? { [sessionKey]: ended } : {},
      replaying,
      done,
    };
  }
  const target = normalizeFocusTarget(params.cfg, params.target ?? "");
  const error = validateFocusTarget(target);
  if (error) {
    throw new Error(error);
  }
  const result = setSessionFocus({ sessionKey: target, tier: params.tier, by: params.by });
  return { action: "set", ...result };
}
