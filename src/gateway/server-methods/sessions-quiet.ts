import { loadConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import {
  resolveQuietSessionSettings,
  setQuietSessionSettings,
  type QuietSessionPatch,
} from "../../sessions/quiet-settings.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { resolveGatewaySessionStoreTarget } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function readKey(params: Record<string, unknown>, respond: RespondFn): string | null {
  const raw = params.sessionKey ?? params.key;
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey required"));
    return null;
  }
  return key;
}

function readBool(
  params: Record<string, unknown>,
  name: keyof QuietSessionPatch,
  respond: RespondFn,
): boolean | undefined | null {
  const value = params[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `${name} must be a boolean`));
    return null;
  }
  return value;
}

/**
 * Quiet sessions ARCH §3.1/§3.3: `sessions.setQuiet` and `sessions.quiet.get`. operator.admin only
 * (method-scopes.ts); `sessions.patch` does not accept these fields.
 * `errorReplies` / `slashCommands`: `false` turns the quiet behaviour on, `true` clears it.
 */
export const sessionsQuietHandlers: GatewayRequestHandlers = {
  "sessions.setQuiet": async ({ params, respond }) => {
    const key = readKey(params, respond);
    if (!key) {
      return;
    }
    const errorReplies = readBool(params, "errorReplies", respond);
    if (errorReplies === null) {
      return;
    }
    const slashCommands = readBool(params, "slashCommands", respond);
    if (slashCommands === null) {
      return;
    }
    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const result = await setQuietSessionSettings({
      storePath: target.storePath,
      storeKeys: target.storeKeys,
      patch: { errorReplies, slashCommands },
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
      return;
    }
    respond(
      true,
      {
        key: target.canonicalKey,
        changed: result.changed,
        ...resolveQuietSessionSettings(result.entry),
      },
      undefined,
    );
  },
  "sessions.quiet.get": async ({ params, respond }) => {
    const key = readKey(params, respond);
    if (!key) {
      return;
    }
    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const store = loadSessionStore(target.storePath);
    const storeKey = target.storeKeys.find((candidate) => Boolean(store[candidate]));
    if (!storeKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    respond(
      true,
      { key: target.canonicalKey, ...resolveQuietSessionSettings(store[storeKey]) },
      undefined,
    );
  },
};
