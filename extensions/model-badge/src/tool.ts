import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/model-badge";
import type { Engine } from "./core/engine.js";
import type { Steering } from "./core/steering.js";
import type { Requester, StyleRuleInput } from "./core/style.js";

// ARCH §2a.3: the agent's steering tool. The agent turns the user's words into rules,
// calls `preview` (which changes nothing and returns rendered samples), and calls `add`
// only after the user confirms.

export const STYLE_TOOL = "model_badge_style";

function text(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export function createStyleTool(params: {
  steering: Steering;
  engines: Engine[];
  senderId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  const { steering } = params;
  // The chat the request comes from, as a badge target id (for member-scoped rules).
  let fromTargetId: string | null = null;
  for (const e of params.engines) {
    const ref = params.sessionKey ? e.provider.targetForSessionKey(params.sessionKey) : null;
    if (ref?.kind === "group") {
      fromTargetId = ref.idLower;
      break;
    }
  }
  const who: Requester = { senderId: params.senderId ?? null, fromTargetId };

  return {
    name: STYLE_TOOL,
    label: "Model Badge Style",
    description:
      "Steer how chat avatars' model badges look. Turn the user's words into style rules, call " +
      "`preview` first (no side effects; shows which models/targets change, with sample images), " +
      "and call `add` only after the user confirms. Rule: { match: { provider?, family?, modelGlob?, " +
      'targetId? ("this" = this chat) }, set: { tone?: "light"|"dark", hue? (e.g. "green"), color? ' +
      "(#RRGGBB), letter?, letterScale? (0.5-1.6), motif? (rings|waves|facets|dots), palette?, prompt? }, " +
      "note? }. Words like claude/gpt/kimi resolve to providers; unknown words are rejected with the " +
      "known list. Global rules are operator-only.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("preview"),
        Type.Literal("add"),
        Type.Literal("remove"),
        Type.Literal("reset"),
      ]),
      rules: Type.Optional(Type.Array(Type.Unknown(), { description: "Rules for preview/add." })),
      ids: Type.Optional(Type.Array(Type.String(), { description: "Rule ids for remove." })),
    }),
    async execute(_id: string, args: Record<string, unknown>) {
      const rules = (Array.isArray(args.rules) ? args.rules : []) as StyleRuleInput[];
      switch (args.action) {
        case "list":
          return text(await steering.list());
        case "preview": {
          const p = await steering.preview(rules, who);
          if (!p.ok) {
            return text(p);
          }
          const { samples, ...rest } = p;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ...rest, samples: samples.map((s) => s.label) }),
              },
              ...samples.map((s) => ({
                type: "image" as const,
                data: s.png.toString("base64"),
                mimeType: "image/png",
              })),
            ],
            details: { ...rest, samples: samples.map((s) => s.label) },
          };
        }
        case "add":
          return text(await steering.add(rules, who));
        case "remove":
          return text(
            await steering.remove(Array.isArray(args.ids) ? args.ids.map(String) : [], who),
          );
        case "reset":
          return text(await steering.reset(who));
        default:
          return text({ ok: false, error: "action must be list, preview, add, remove or reset" });
      }
    },
  } as AnyAgentTool;
}
