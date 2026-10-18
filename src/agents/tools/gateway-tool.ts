import { Type } from "@sinclair/typebox";
import { isRestartEnabled } from "../../config/commands.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveConfigSnapshotHash } from "../../config/io.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, OWNER_ONLY_TOOL_ERROR, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

const log = createSubsystemLogger("gateway-tool");

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: typeof hashValue === "string" ? hashValue : undefined,
    raw: typeof rawValue === "string" ? rawValue : undefined,
  });
  return hash ?? undefined;
}

const GATEWAY_ACTIONS = [
  "restart",
  "config.get",
  "config.schema.lookup",
  "config.apply",
  "config.patch",
  "update.run",
  "focus",
  // Agent peers ARCH §2a: operator-only trust-graph and quiet-session actions.
  "signal.trust.markAgent",
  "signal.trust.unmarkAgent",
  "sessions.setQuiet",
] as const;

/** Agent peers ARCH §2a: actions allowed only when the current turn's sender is an operator. */
const OPERATOR_TURN_ACTIONS = new Set<string>([
  "signal.trust.markAgent",
  "signal.trust.unmarkAgent",
  "sessions.setQuiet",
]);

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  // config.get, config.schema.lookup, config.apply, update.run
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // config.schema.lookup
  path: Type.Optional(Type.String()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  // config.apply, config.patch, update.run, sessions.setQuiet
  sessionKey: Type.Optional(Type.String()),
  // signal.trust.markAgent, signal.trust.unmarkAgent
  uuid: Type.Optional(Type.String()),
  account: Type.Optional(Type.String()),
  // sessions.setQuiet: false = quiet (off), true = back to default
  errorReplies: Type.Optional(Type.Boolean()),
  slashCommands: Type.Optional(Type.Boolean()),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Number()),
  // focus (focus mode: set <target> | off | status)
  focusAction: Type.Optional(stringEnum(["set", "off", "status"] as const)),
  target: Type.Optional(Type.String()),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  /** Whether the current turn's sender is an operator (owner). */
  senderIsOwner?: boolean;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    ownerOnly: true,
    description:
      "Restart, inspect a specific config schema path, apply config, or update the gateway in-place (SIGUSR1). Focus mode (action=focus, focusAction=set+target|off|status): only the target session runs while others' messages wait; use it only when an operator asks. signal.trust.markAgent / signal.trust.unmarkAgent (uuid) mark or unmark a trusted Signal identity as another agent; sessions.setQuiet (sessionKey, errorReplies?, slashCommands?; false = quiet, true = default) sets a session's quiet settings. These three call the same gateway methods as the CLI and are allowed only when the current turn's sender is an operator (senderIsOwner); otherwise they are refused. Use config.schema.lookup with a targeted dot path before config edits. Use config.patch for safe partial config updates (merges with existing). Use config.apply only when replacing entire config. Both trigger restart after writing. Always pass a human-readable completion message via the `note` parameter so the system can deliver it to the user after restart.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (OPERATOR_TURN_ACTIONS.has(action)) {
        // Agent peers ARCH §2a: refused unless the sender of this turn is an operator.
        if (opts?.senderIsOwner !== true) {
          throw new Error(OWNER_ONLY_TOOL_ERROR);
        }
        const gatewayOpts = readGatewayCallOptions(params);
        if (action === "sessions.setQuiet") {
          const sessionKey =
            readStringParam(params, "sessionKey") ?? opts?.agentSessionKey?.trim() ?? "";
          if (!sessionKey) {
            throw new Error("sessionKey required");
          }
          const errorReplies =
            typeof params.errorReplies === "boolean" ? params.errorReplies : undefined;
          const slashCommands =
            typeof params.slashCommands === "boolean" ? params.slashCommands : undefined;
          if (errorReplies === undefined && slashCommands === undefined) {
            throw new Error("errorReplies and/or slashCommands required");
          }
          const result = await callGatewayTool("sessions.setQuiet", gatewayOpts, {
            sessionKey,
            ...(errorReplies !== undefined ? { errorReplies } : {}),
            ...(slashCommands !== undefined ? { slashCommands } : {}),
          });
          return jsonResult({ ok: true, result });
        }
        const uuid = readStringParam(params, "uuid", { required: true });
        const account = readStringParam(params, "account");
        const result = await callGatewayTool(action, gatewayOpts, {
          uuid,
          ...(account ? { account } : {}),
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "restart") {
        if (!isRestartEnabled(opts?.config)) {
          throw new Error("Gateway restart is disabled (commands.restart=false).");
        }
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason =
          typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim().slice(0, 200)
            : undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        // Extract channel + threadId for routing after restart
        // Supports both :thread: (most channels) and :topic: (Telegram)
        const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
          },
        };
        try {
          await writeRestartSentinel(payload);
        } catch {
          // ignore: sentinel is best-effort
        }
        log.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayOpts = readGatewayCallOptions(params);

      const resolveGatewayWriteMeta = (): {
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      } => {
        const sessionKey =
          typeof params.sessionKey === "string" && params.sessionKey.trim()
            ? params.sessionKey.trim()
            : opts?.agentSessionKey?.trim() || undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        return { sessionKey, note, restartDelayMs };
      };

      const resolveConfigWriteParams = async (): Promise<{
        raw: string;
        baseHash: string;
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      }> => {
        const raw = readStringParam(params, "raw", { required: true });
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        if (!baseHash) {
          throw new Error("Missing baseHash from config snapshot.");
        }
        return { raw, baseHash, ...resolveGatewayWriteMeta() };
      };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema.lookup") {
        const path = readStringParam(params, "path", {
          required: true,
          label: "path",
        });
        const result = await callGatewayTool("config.schema.lookup", gatewayOpts, { path });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        const { raw, baseHash, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.patch") {
        const { raw, baseHash, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        const result = await callGatewayTool("config.patch", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "update.run") {
        const { sessionKey, note, restartDelayMs } = resolveGatewayWriteMeta();
        const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: updateTimeoutMs,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          restartDelayMs,
          timeoutMs: updateTimeoutMs,
        });
        return jsonResult({ ok: true, result });
      }

      if (action === "focus") {
        const focusAction = readStringParam(params, "focusAction") ?? "status";
        const target =
          focusAction === "set"
            ? readStringParam(params, "target", { required: true, label: "target" })
            : undefined;
        const result = await callGatewayTool(
          "focus",
          gatewayOpts,
          target ? { action: focusAction, target } : { action: focusAction },
        );
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
