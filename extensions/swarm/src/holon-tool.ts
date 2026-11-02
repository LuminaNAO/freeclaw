import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/swarm";
import { answerChild, directChildKey, spawnChild } from "./children.js";
import type { SwarmEngine } from "./engine.js";
import { TASKMASTER } from "./routing.js";
import { parseSwarmSessionKey } from "./sessions.js";
import { cancelTask } from "./tasks.js";

// swarm_holon: the lead's hand on its holarchy (ARCH §5.1, §10a.1). Thin: every action calls
// the same ops function as the `swarm` CLI and the gateway method. Identity (which holon is
// the parent) comes only from the calling session key; a lead acts on its own children only.

export const SWARM_HOLON_TOOL = "swarm_holon";

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
  return {
    name: SWARM_HOLON_TOOL,
    label: "Swarm Holon",
    description:
      "Lead only: manage this holon's child holons (ARCH §5). action=spawn creates a child " +
      "from a holon.yaml text (id, goal, done_when, lanes, optional lead/canon; the canon may " +
      "only tighten yours). action=answer sends a message to a child's lead. action=cancel " +
      "stops a child and its subtree. Children report back as CHILD_DONE / CHILD_BLOCKED / " +
      "CHILD_FAILED. This does not end your turn: still end it with swarm_emit.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("spawn"), Type.Literal("answer"), Type.Literal("cancel")]),
      holon: Type.Optional(Type.String({ description: "spawn: the child holon.yaml text." })),
      child: Type.Optional(Type.String({ description: "answer/cancel: the child holon id." })),
      message: Type.Optional(
        Type.String({ description: "answer: the message; cancel: the reason." }),
      ),
    }),
    async execute(_id: string, args: Record<string, unknown>) {
      const ref = parseSwarmSessionKey(callerSessionKey);
      if (!ref || ref.role !== TASKMASTER) {
        return result({ ok: false, error: "swarm_holon is only available to a holon's lead" });
      }
      const parent = ref.taskId;
      const text = (key: string) =>
        typeof args[key] === "string" && (args[key] as string).trim()
          ? (args[key] as string)
          : undefined;
      try {
        switch (args.action) {
          case "spawn": {
            const holon = text("holon");
            if (!holon) {
              return result({ ok: false, error: "spawn needs `holon` (the child holon.yaml)" });
            }
            const spawned = await spawnChild(engine, parent, holon);
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
          default:
            return result({ ok: false, error: "action must be spawn, answer or cancel" });
        }
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
