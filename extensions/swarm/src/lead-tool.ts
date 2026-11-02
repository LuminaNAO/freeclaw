import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/swarm";
import type { SwarmEngine } from "./engine.js";
import { runOp, SWARM_OPS, type OpCaller } from "./ops.js";
import { TASKMASTER } from "./routing.js";
import { parseSwarmSessionKey } from "./sessions.js";

// The lead's tool (ARCH §5.1, §10a preamble): one tool, `swarm_holon`, whose `op` names a row
// of SWARM_OPS. It calls runOp, the same dispatch the gateway method (and the CLI) use; it has
// no logic of its own. Only a holon lead's session gets it; identity comes from the session
// key, never from a parameter.

export const SWARM_HOLON_TOOL = "swarm_holon";

/** The ops a lead may call, in table order. */
export function leadToolOps(): string[] {
  return Object.entries(SWARM_OPS)
    .filter(([, op]) => op.leadTool)
    .map(([name]) => name);
}

function result(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

export function createSwarmHolonTool(params: {
  engine: SwarmEngine;
  callerSessionKey?: string;
}): AnyAgentTool {
  const { engine, callerSessionKey } = params;
  const ops = leadToolOps();
  return {
    name: SWARM_HOLON_TOOL,
    label: "Swarm Holon",
    description:
      "Lead-only holon operations (the same ones as the `swarm` CLI): " +
      `${ops.join(", ")}. add = queue more work to a child holon's lead (urgent: true steers); ` +
      "lead = change a holon's lead (root owner only); showTree = read a holon and its tree. " +
      "This does not end your turn: still finish with swarm_emit.",
    parameters: Type.Object({
      op: Type.String({ description: `One of: ${ops.join(", ")}.` }),
      holon: Type.String({ description: "Holon path: <root>[/<child>...]." }),
      text: Type.Optional(Type.String({ description: "add: the work, plain text." })),
      urgent: Type.Optional(Type.Boolean({ description: "add: steer instead of queue." })),
      spec: Type.Optional(Type.String({ description: "lead: the new lead spec." })),
      tree: Type.Optional(Type.Boolean({ description: "showTree: include the holon tree." })),
      limit: Type.Optional(Type.Number({ description: "showTree: only the last N events." })),
    }),
    async execute(_id: string, args: Record<string, unknown>) {
      const ref = parseSwarmSessionKey(callerSessionKey);
      if (!ref || ref.role !== TASKMASTER) {
        return result({ ok: false, error: `${SWARM_HOLON_TOOL} is only for a holon's lead` });
      }
      const op = typeof args.op === "string" ? args.op.trim() : "";
      if (!ops.includes(op)) {
        return result({ ok: false, error: `unknown op "${op}"; use one of ${ops.join(", ")}` });
      }
      const caller: OpCaller = {
        kind: "session",
        sessionKey: callerSessionKey ?? "",
        taskId: ref.taskId,
        role: ref.role,
      };
      try {
        const out = await runOp(op, engine, { ...args }, caller);
        return result({ ok: true, result: out as unknown });
      } catch (err) {
        return result({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  } as AnyAgentTool;
}

/** Tool factory for registerTool: only a swarm lead session sees the tool. */
export function createSwarmHolonToolFactory(engine: () => SwarmEngine | undefined) {
  return (ctx: { sessionKey?: string }): AnyAgentTool | null => {
    const current = engine();
    const ref = parseSwarmSessionKey(ctx.sessionKey);
    if (!current || !ref || ref.role !== TASKMASTER) {
      return null;
    }
    return createSwarmHolonTool({ engine: current, callerSessionKey: ctx.sessionKey });
  };
}
