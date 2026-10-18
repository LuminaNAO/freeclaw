import { normalizeAccountId } from "../../routing/account-id.js";
import { canonicalizeTrustInput } from "../../signal/trust/identity.js";
import {
  listSignalAgentUuids,
  readSignalTrustStoreForCli,
  setSignalTrustAgentMark,
} from "../../signal/trust/store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlers, RespondFn } from "./types.js";

function readAccount(params: Record<string, unknown>): string {
  return normalizeAccountId(typeof params.account === "string" ? params.account : undefined);
}

function readUuid(params: Record<string, unknown>, respond: RespondFn): string | null {
  const raw = typeof params.uuid === "string" ? params.uuid : "";
  const parsed = raw ? canonicalizeTrustInput(raw) : null;
  if (!parsed || parsed.kind !== "uuid") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "uuid must be a Signal sender uuid (uuid:<id>)"),
    );
    return null;
  }
  return parsed.value;
}

/**
 * Agent peers ARCH §2.1/§2.4: the gateway counterparts of `openclaw signal trust mark-agent`,
 * `unmark-agent` and the marked-agent part of `status`. All are operator.admin (method-scopes.ts),
 * so agent tools, which call the gateway with least-privilege scopes, cannot reach them.
 */
function markHandler(agent: boolean): GatewayRequestHandler {
  return async ({ params, respond }) => {
    const uuid = readUuid(params, respond);
    if (!uuid) {
      return;
    }
    const accountId = readAccount(params);
    try {
      const result = await setSignalTrustAgentMark({ accountId, uuid, agent });
      if (!result.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
        return;
      }
      respond(true, { accountId, uuid, agent, changed: result.changed }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  };
}

export const signalTrustHandlers: GatewayRequestHandlers = {
  "signal.trust.markAgent": markHandler(true),
  "signal.trust.unmarkAgent": markHandler(false),
  "signal.trust.agents": async ({ params, respond }) => {
    const accountId = readAccount(params);
    const { snapshot } = await readSignalTrustStoreForCli({ accountId });
    respond(
      true,
      {
        accountId,
        storeValid: snapshot.ok,
        agents: snapshot.ok ? listSignalAgentUuids(snapshot.trusted) : [],
      },
      undefined,
    );
  },
};
