import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/model-badge";
import { ACTIONS, createActions, isAction, type Action, type ActionDeps } from "./actions.js";
import type { Engine } from "./core/engine.js";
import type { TargetRef } from "./core/provider.js";
import type { StyleRuleInput } from "./core/style.js";

// ARCH §2c.1: one agent tool covers everything `/badge` does, through the same action
// dispatcher. The §2a.3 name `model_badge_style` stays as an alias: it is the same tool
// and also accepts the old short style actions (list | preview | add | remove | reset).
// Authority (§2c.2) is decided on the sender id the gateway passes to the tool factory;
// no argument the model writes can change who is asking or which group they are in.

export const BADGE_TOOL = "model_badge";
export const STYLE_TOOL = "model_badge_style";
export const TOOL_NAMES = [BADGE_TOOL, STYLE_TOOL] as const;

const LEGACY_STYLE_ACTIONS: Record<string, Action> = {
  list: "style.list",
  preview: "style.preview",
  add: "style.add",
  remove: "style.remove",
  reset: "style.reset",
};

export const TOOL_DESCRIPTION =
  "Model badge avatars: each chat's picture shows the badge of the model it uses. You can " +
  "restyle, repaint and regenerate a group's avatar when a member of that group asks, and " +
  "check its status. Actions: status (this chat; operators may pass all), style.list, " +
  "style.preview, style.add, style.remove, style.reset, repaint, regenerate (a new picture " +
  "from the image model; replaces a group's own adopted artwork), restore (puts the " +
  "group's own artwork back), audit, purge (operator-only, needs confirm). A group's own " +
  "artwork is kept as its background: restyling does not replace it, only regenerate " +
  "does, so say so before regenerating. Always call " +
  "style.preview first (no side effects; shows which models/targets change, with sample " +
  "images) and call style.add only after the user confirms. Rule: { match: { provider?, " +
  'family?, modelGlob?, targetId? ("this" = this chat) }, set: { tone?: "light"|"dark", ' +
  'hue? (e.g. "green"), color? (#RRGGBB), letter?, letterScale? (0.5-1.6), motif? ' +
  "(rings|waves|facets|dots), palette?, prompt? (words for the image model, e.g. " +
  '"watercolour ocean") }, note? }. Words like claude/gpt/kimi resolve to providers; unknown ' +
  "words are rejected with the known list. Members may act on the group they are in; " +
  "global rules (provider/family/model), other groups, the profile and purge are " +
  "operator-only. A refusal says why and who can do it: pass that on to the user.";

function textOf(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

// The chat the request comes from, as a badge target of one of the engines.
function hereOf(
  engines: Engine[],
  sessionKey: string | undefined,
): { engine: Engine | null; here: TargetRef | null } {
  if (!sessionKey) {
    return { engine: null, here: null };
  }
  for (const e of engines) {
    const ref = e.provider.targetForSessionKey(sessionKey);
    if (ref?.kind === "group") {
      return { engine: e, here: ref };
    }
  }
  return { engine: null, here: null };
}

export function createBadgeTool(
  params: ActionDeps & {
    name?: (typeof TOOL_NAMES)[number];
    // From the gateway's tool context, never from the model.
    senderId?: string;
    sessionKey?: string;
  },
): AnyAgentTool {
  const run = createActions(params);
  const name = params.name ?? BADGE_TOOL;
  return {
    name,
    label: name === BADGE_TOOL ? "Model Badge" : "Model Badge Style",
    description:
      name === BADGE_TOOL
        ? TOOL_DESCRIPTION
        : `Alias of ${BADGE_TOOL}; list | preview | add | remove | reset also work. ${TOOL_DESCRIPTION}`,
    parameters: Type.Object({
      action: Type.Union(
        [
          ...ACTIONS.map((a) => Type.Literal(a)),
          ...(name === STYLE_TOOL
            ? Object.keys(LEGACY_STYLE_ACTIONS).map((a) => Type.Literal(a))
            : []),
        ],
        { description: "What to do." },
      ),
      target: Type.Optional(
        Type.String({
          description:
            'status/repaint/regenerate/restore: "this" (default: this chat), a target id, or "profile".',
        }),
      ),
      all: Type.Optional(Type.Boolean({ description: "status: every target (operators)." })),
      rules: Type.Optional(
        Type.Array(Type.Unknown(), { description: "Rules for style.preview / style.add." }),
      ),
      ids: Type.Optional(Type.Array(Type.String(), { description: "Rule ids for style.remove." })),
      confirm: Type.Optional(
        Type.Boolean({ description: "purge: true only after the operator confirmed." }),
      ),
    }),
    async execute(_id: string, args: Record<string, unknown>) {
      const raw = args.action;
      const action: Action | null = isAction(raw)
        ? raw
        : typeof raw === "string"
          ? (LEGACY_STYLE_ACTIONS[raw] ?? null)
          : null;
      if (!action) {
        return textOf({ ok: false, error: `action must be one of ${ACTIONS.join(", ")}` });
      }
      const engines = params.engines();
      const { engine, here } = hereOf(engines, params.sessionKey);
      const r = await run(
        action,
        {
          target: typeof args.target === "string" ? args.target : undefined,
          all: args.all === true,
          rules: (Array.isArray(args.rules) ? args.rules : []) as StyleRuleInput[],
          ids: Array.isArray(args.ids) ? args.ids.map(String) : [],
          confirm: args.confirm === true,
        },
        { senderId: params.senderId ? String(params.senderId) : null, engine, here },
      );
      const details = { ...r.details, message: r.text };
      if (!r.samples?.length) {
        return textOf(details);
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(details) },
          ...r.samples.map((s) => ({
            type: "image" as const,
            data: s.png.toString("base64"),
            mimeType: "image/png",
          })),
        ],
        details,
      };
    },
  } as AnyAgentTool;
}
