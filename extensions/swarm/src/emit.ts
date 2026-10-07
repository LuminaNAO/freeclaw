import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/swarm";
import type { SwarmEngine } from "./engine.js";
import { parseSwarmSessionKey } from "./sessions.js";

// swarm_emit tool (ARCH §4, §5).

export const SWARM_EMIT_TOOL = "swarm_emit";

function result(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

/**
 * Build the tool for one calling session. Identity (task + role) comes only from the
 * session key; there is no parameter that can set or override it.
 */
export function createSwarmEmitTool(params: {
  engine: SwarmEngine;
  callerSessionKey?: string;
}): AnyAgentTool {
  const { engine, callerSessionKey } = params;
  return {
    name: SWARM_EMIT_TOOL,
    label: "Swarm Emit",
    description:
      "Emit a routed swarm event for your task. Call this exactly once at the end of every turn: " +
      "the event name (e.g. BUILD_DONE, AUDIT_PASS, AUDIT_FAIL, TEST_PASS, TEST_FAIL, BLOCKED), " +
      "the commit sha it applies to, and a body with your evidence or findings.",
    parameters: Type.Object({
      event: Type.String({ description: "Event name, e.g. BUILD_DONE or AUDIT_FAIL." }),
      sha: Type.String({ description: "Commit sha this event applies to." }),
      body: Type.String({ description: "Evidence, findings, or the ask." }),
      role: Type.Optional(
        Type.String({ description: "RETRY only (taskmaster): the worker role to re-prompt." }),
      ),
    }),
    async execute(_id: string, args: Record<string, unknown>) {
      const ref = parseSwarmSessionKey(callerSessionKey);
      if (!ref) {
        return result({
          ok: false,
          error: "swarm_emit is only available in a swarm task session (non-swarm session)",
        });
      }
      const event = typeof args.event === "string" ? args.event : "";
      const sha = typeof args.sha === "string" ? args.sha.trim() : "";
      if (!event.trim() || !sha) {
        return result({ ok: false, error: "event and sha are required" });
      }
      const outcome = await engine.emit(ref.taskId, ref.role, {
        event,
        sha,
        body: typeof args.body === "string" ? args.body : "",
        role: typeof args.role === "string" ? args.role : undefined,
      });
      return result(outcome);
    },
  } as AnyAgentTool;
}

/** Tool factory for registerTool: only exposes the tool inside swarm sessions. */
export function createSwarmEmitToolFactory(engine: () => SwarmEngine | undefined) {
  return (ctx: { sessionKey?: string }): AnyAgentTool | null => {
    const current = engine();
    if (!current || !parseSwarmSessionKey(ctx.sessionKey)) {
      return null;
    }
    return createSwarmEmitTool({ engine: current, callerSessionKey: ctx.sessionKey });
  };
}
