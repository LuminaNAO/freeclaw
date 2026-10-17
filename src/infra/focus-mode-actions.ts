// Focus mode actions shared by the chat command, the CLI and the gateway method
// (docs/design/focus-mode.md §4). Authority is checked by each caller.
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { normalizeMainKey, toAgentStoreSessionKey } from "../routing/session-key.js";
import {
  endFocusMode,
  type FocusState,
  type FocusStatus,
  readFocusStatus,
  setFocusState,
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
  | { action: "set"; focus: FocusState }
  | { action: "off"; ended: FocusState | undefined; replaying: number; done: Promise<void> }
  | { action: "status"; status: FocusStatus };

export function runFocusAction(params: {
  cfg: OpenClawConfig;
  action: "set" | "off" | "status";
  target?: string;
  by: string;
}): FocusActionResult {
  if (params.action === "status") {
    return { action: "status", status: readFocusStatus() };
  }
  if (params.action === "off") {
    const { ended, replaying, done } = endFocusMode();
    return { action: "off", ended, replaying, done };
  }
  const target = normalizeFocusTarget(params.cfg, params.target ?? "");
  const error = validateFocusTarget(target);
  if (error) {
    throw new Error(error);
  }
  return { action: "set", focus: setFocusState({ target, by: params.by }) };
}
