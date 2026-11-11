// Gateway methods `mail.connectors.{list,status,test,restart}` (docs/design/mail-push.md §7).
// The response is the ops report, the same JSON as `openclaw mail connectors <verb> --json`.
// list/status are read-scoped; test/restart are admin-scoped (method-scopes.ts).
import { getActiveMailConnectorManager } from "../../mail/manager.js";
import {
  MAIL_CONNECTOR_METHODS,
  type MailConnectorVerb,
  readConnectorIdParam,
  runMailConnectorOp,
} from "../../mail/ops.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

function handler(verb: MailConnectorVerb): GatewayRequestHandler {
  return async ({ params, respond }) => {
    const parsed = readConnectorIdParam(params, verb === "test" || verb === "restart");
    if ("error" in parsed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsed.error));
      return;
    }
    const manager = getActiveMailConnectorManager();
    if (!manager) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "mail connectors are not running in this gateway"),
      );
      return;
    }
    try {
      respond(true, await runMailConnectorOp(manager, verb, parsed.id), undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.startsWith("unknown mail connector")
        ? ErrorCodes.INVALID_REQUEST
        : ErrorCodes.UNAVAILABLE;
      respond(false, undefined, errorShape(code, message));
    }
  };
}

export const mailHandlers: GatewayRequestHandlers = {
  [MAIL_CONNECTOR_METHODS.list]: handler("list"),
  [MAIL_CONNECTOR_METHODS.status]: handler("status"),
  [MAIL_CONNECTOR_METHODS.test]: handler("test"),
  [MAIL_CONNECTOR_METHODS.restart]: handler("restart"),
};
