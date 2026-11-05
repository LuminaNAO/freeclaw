// Gateway method `focus` (docs/design/focus-mode.md §7.4): status, set and off,
// through the same ops function as `/focus` and `openclaw gateway focus`.
// Operator authority only: the method is in the admin scope (method-scopes.ts).
//
// Params: { action?: "status"|"set"|"off", target?: string, tier?: "normal"|"hyper",
// all?: boolean }. `off` without a target (or with all) clears all focus.
// The response is the FocusReport, the same JSON as `openclaw gateway focus --json`.
import { loadConfig } from "../../config/config.js";
import { type FocusOpRequest, runFocusOp } from "../../infra/focus-mode-actions.js";
import { resolveControlPlaneActor } from "../control-plane-audit.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The request as the method receives it, or an error message. */
export function parseFocusMethodParams(
  params: Record<string, unknown>,
): FocusOpRequest | { error: string } {
  const action = (readString(params.action) ?? "status").toLowerCase();
  const target = readString(params.target);
  const tier = readString(params.tier);
  if (action === "status") {
    return { action: "status" };
  }
  if (action === "set") {
    if (!target) {
      return { error: "focus set: target required" };
    }
    return { action: "set", target, ...(tier ? { tier } : {}) };
  }
  if (action === "off") {
    if (params.all === true && target) {
      return { error: "focus off: give a target or all, not both" };
    }
    return target ? { action: "off", target } : { action: "off", all: true };
  }
  return { error: "focus: action must be status, set or off" };
}

export const focusHandlers: GatewayRequestHandlers = {
  focus: ({ params, respond, client, context }) => {
    const request = parseFocusMethodParams(params);
    if ("error" in request) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, request.error));
      return;
    }
    const by = resolveControlPlaneActor(client).actor;
    try {
      const { report } = runFocusOp({ cfg: loadConfig(), request, by });
      if (report.action === "set") {
        context.logGateway.info(
          `focus: ${report.sessionKey} ${report.previousTier} -> ${report.tier} by ${by}; active level ${report.status.active}; replaying ${report.replaying} session(s)`,
        );
      } else if (report.action === "off" && Object.keys(report.ended).length > 0) {
        context.logGateway.info(
          `focus: off ${report.sessionKey ?? "(all)"} by ${by}; active level ${report.status.active}; replaying ${report.replaying} session(s)`,
        );
      }
      respond(true, report, undefined);
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
