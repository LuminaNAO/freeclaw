import type { OpenClawConfig } from "./config.js";

/**
 * Command users run to opt in to the web Control UI.
 */
export const CONTROL_UI_ENABLE_COMMAND = "openclaw config set gateway.controlUi.enabled true";

/**
 * Whether the gateway serves the web Control UI.
 *
 * The Control UI is opt-in: it is enabled only when `gateway.controlUi.enabled`
 * is explicitly `true`. Unset (or any non-true value) means off.
 *
 * Every reader of `gateway.controlUi.enabled` goes through this helper so the
 * default cannot drift between the gateway runtime, status, and onboarding.
 */
export function isControlUiEnabled(cfg: OpenClawConfig | null | undefined): boolean {
  return cfg?.gateway?.controlUi?.enabled === true;
}
