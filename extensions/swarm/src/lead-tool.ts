import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/swarm";
import { answerChild, directChildKey, type spawnChild } from "./children.js";
import type { SwarmEngine } from "./engine.js";
import { runOp, SWARM_OPS, type OpCaller } from "./ops.js";
import { TASKMASTER } from "./routing.js";
import { parseSwarmSessionKey } from "./sessions.js";
import { cancelTask } from "./tasks.js";

// The lead's tool (ARCH §5.1, §10a preamble): one tool, `swarm_holon`, for everything a lead
// does to its holarchy. `action` names a child-holon action (spawn / answer / cancel, ARCH §5,
// §10a.1); `op` names a row of SWARM_OPS (add / lead / showTree …, ARCH §10a.2). Both paths
// call the same ops functions as the `swarm` CLI and the gateway methods; the tool has no
// logic of its own. Only a holon lead's session gets it; identity (which holon is the parent)
// comes from the session key, never from a parameter.

export const SWARM_HOLON_TOOL = "swarm_holon";

/** The table ops a lead may call, in table order. */
export function leadToolOps(): string[] {
  return Object.entries(SWARM_OPS)
    .filter(([, op]) => op.leadTool)
    .map(([name]) => name);
}

const ACTIONS = ["spawn", "answer", "cancel"] as const;

function result(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      "Lead only: manage this holon's children and tree (the same operations as the `swarm` " +
      "CLI). action=spawn creates a child holon from a holon.yaml text (the canon may only " +
      "tighten yours); action=answer messages a child's lead; action=cancel stops a child and " +
      `its subtree. op (one of: ${ops.join(", ")}): add = queue more work to a child holon's ` +
      "lead (urgent: true steers); lead = change a holon's lead (root owner only); showTree = " +
      "read a holon and its tree; spawn = the same as action=spawn. Children report back as CHILD_DONE / CHILD_BLOCKED / " +
      "CHILD_FAILED. This does not end your turn: still finish with swarm_emit.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          ACTIONS.map((a) => Type.Literal(a)),
          {
            description: "Child action: spawn, answer or cancel.",
          },
        ),
      ),
      op: Type.Optional(Type.String({ description: `Table op, one of: ${ops.join(", ")}.` })),
      holon: Type.Optional(
        Type.String({
          description:
            "spawn: the child holon.yaml text. Table ops: the holon path <root>[/<child>...].",
        }),
      ),
      child: Type.Optional(Type.String({ description: "answer/cancel: the child holon id." })),
      message: Type.Optional(
        Type.String({ description: "answer: the message; cancel: the reason." }),
      ),
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
      const parent = ref.taskId;
      const text = (key: string) =>
        typeof args[key] === "string" && (args[key] as string).trim()
          ? (args[key] as string)
          : undefined;
      const action = text("action");
      const sessionCaller = (): OpCaller => ({
        kind: "session",
        sessionKey: callerSessionKey ?? "",
        taskId: ref.taskId,
        role: ref.role,
      });
      try {
        switch (action) {
          case "spawn": {
            const holon = text("holon");
            if (!holon) {
              return result({ ok: false, error: "spawn needs `holon` (the child holon.yaml)" });
            }
            // The same table op as `swarm spawn` and swarm.spawn (ARCH §10a parity).
            const spawned = (await runOp("spawn", engine, { holon }, sessionCaller())) as Awaited<
              ReturnType<typeof spawnChild>
            >;
            return result({
              ok: true,
              child: spawned.taskId,
              sha: spawned.sha,
              canon: spawned.canon,
            });
          }
          case "answer": {
            const child = text("child");
            const message = text("message");
            if (!child || !message) {
              return result({ ok: false, error: "answer needs `child` and `message`" });
            }
            return result({ ok: true, ...(await answerChild(engine, parent, child, message)) });
          }
          case "cancel": {
            const child = text("child");
            if (!child) {
              return result({ ok: false, error: "cancel needs `child`" });
            }
            const key = directChildKey(parent, child);
            return result({
              ok: true,
              ...(await cancelTask(engine, key, text("message") ?? "cancelled by the parent lead")),
            });
          }
          case undefined:
            break;
          default:
            return result({ ok: false, error: "action must be spawn, answer or cancel" });
        }
        const op = text("op") ?? "";
        if (!ops.includes(op)) {
          return result({
            ok: false,
            error: op
              ? `unknown op "${op}"; use one of ${ops.join(", ")}`
              : `need \`action\` (${ACTIONS.join(", ")}) or \`op\` (${ops.join(", ")})`,
          });
        }
        const out = await runOp(op, engine, { ...args }, sessionCaller());
        return result({ ok: true, result: out as unknown });
      } catch (err) {
        return result({ ok: false, error: errorText(err) });
      }
    },
  } as AnyAgentTool;
}

/** Tool factory for registerTool: only a holon's lead session sees the tool. */
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
