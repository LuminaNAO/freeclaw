// docs/design/gateway-crash-log.md §1.4: after channels start, enqueue one system event to the
// main session when the previous run crashed. No channel code: the agent relays it.
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { takeCrashAnnouncement } from "../infra/gateway-crash-log.js";
import { enqueueSystemEvent } from "../infra/system-events.js";

export function announceGatewayCrash(
  cfg: OpenClawConfig,
  log: { warn: (msg: string) => void },
): boolean {
  const text = takeCrashAnnouncement();
  if (!text) {
    return false;
  }
  const sessionKey = resolveMainSessionKey(cfg);
  enqueueSystemEvent(text, { sessionKey, contextKey: "gateway-crash" });
  log.warn(`crash announced to ${sessionKey}: ${text}`);
  return true;
}
