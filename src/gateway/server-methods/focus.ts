// Gateway method `focus` (docs/design/focus-mode.md §4): set, off and status.
// Operator authority only: the method is in the admin scope (method-scopes.ts).
import { loadConfig } from "../../config/config.js";
import { runFocusAction } from "../../infra/focus-mode-actions.js";
import { resolveControlPlaneActor } from "../control-plane-audit.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const focusHandlers: GatewayRequestHandlers = {
  focus: ({ params, respond, client, context }) => {
    const actionRaw = typeof params.action === "string" ? params.action.trim().toLowerCase() : "";
    const action = actionRaw || "status";
    if (action !== "set" && action !== "off" && action !== "status") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "focus: action must be set, off or status"),
      );
      return;
    }
    const target = typeof params.target === "string" ? params.target : undefined;
    if (action === "set" && !target?.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "focus set: target required"),
      );
      return;
    }
    const by = resolveControlPlaneActor(client).actor;
    try {
      const result = runFocusAction({ cfg: loadConfig(), action, target, by });
      if (result.action === "set") {
        context.logGateway.info(`focus mode: on ${result.sessionKey} by ${by}`);
        respond(
          true,
          { focus: { target: result.sessionKey, ...result.entry }, replaying: result.replaying },
          undefined,
        );
        return;
      }
      if (result.action === "off") {
        if (Object.keys(result.ended).length > 0) {
          context.logGateway.info(
            `focus mode: off by ${by}; replaying ${result.replaying} session(s)`,
          );
        }
        respond(true, { ended: result.ended, replaying: result.replaying }, undefined);
        return;
      }
      respond(true, result.status, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `focus: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};
