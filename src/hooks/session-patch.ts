import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionsPatchParams } from "../gateway/protocol/index.js";
import {
  hasInternalHookListeners,
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
  triggerInternalHook,
} from "./internal-hooks.js";

/**
 * Emit `session:patch` after a session entry has been changed and persisted.
 *
 * Shared by the gateway `sessions.patch` RPC and the chat-side model switch
 * paths (`/model`, `/new <model>`), so a single hook observes every model
 * change regardless of where it originated. Fire-and-forget: hook errors are
 * logged by `triggerInternalHook` and never surface to the caller.
 */
export function emitSessionPatchHook(params: {
  sessionKey: string;
  sessionEntry: SessionEntry;
  /** Only the fields that changed, e.g. `{ model: "provider/model" }`. */
  patch: SessionsPatchParams;
  cfg: OpenClawConfig;
}): void {
  if (!hasInternalHookListeners("session", "patch")) {
    return;
  }
  // Clone so handlers cannot mutate the live session entry or config.
  const context: SessionPatchHookContext = structuredClone({
    sessionEntry: params.sessionEntry,
    patch: params.patch,
    cfg: params.cfg,
  });
  const event: SessionPatchHookEvent = {
    type: "session",
    action: "patch",
    sessionKey: params.sessionKey,
    context,
    timestamp: new Date(),
    messages: [],
  };
  void triggerInternalHook(event);
}
