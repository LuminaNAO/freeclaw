import {
  createActions,
  type Action,
  type ActionArgs,
  type ActionDeps,
  type ActionContext,
} from "./actions.js";
import type { Engine } from "./core/engine.js";
import type { TargetRef } from "./core/provider.js";
import type { StyleRuleInput } from "./core/style.js";

// `/badge` (ARCH §5.3, §2a.3, §2b.4, §2c.1). A thin parser over the shared action
// dispatcher: every subcommand maps to one agent-tool action with the same effect and
// result, and authority is decided in the dispatcher, not here. Commands never call a
// provider: mutating actions only change engine state, so each engine stays the single
// writer.

export type BadgeCommandContext = {
  senderId?: string;
  channel: string;
  channelId?: string;
  args?: string;
  from?: string;
  to?: string;
};

export type BadgeCommandDeps = Omit<ActionDeps, "allowGroupMembers"> & {
  allowGroupMembers?: () => boolean;
};

type Parsed = { ok: true; args: ActionArgs } | { ok: false; text: string };
const ok = (args: ActionArgs = {}): Parsed => ({ ok: true, args });

function parseRules(text: string): StyleRuleInput[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    return (Array.isArray(v) ? v : [v]) as StyleRuleInput[];
  } catch {
    return null;
  }
}

const RULE_HINT =
  'Give the rule as JSON, e.g. {"match":{"provider":"anthropic"},"set":{"tone":"light"}}';

// The slash subcommands and the tool action each one runs (§2c.1). The parser below is
// driven by this table, and the parity test enumerates it.
export const SLASH_SUBCOMMANDS: Record<
  string,
  { action: Action; parse: (rest: string[], body: string) => Parsed }
> = {
  status: { action: "status", parse: (r) => ok(r[0] === "all" ? { all: true } : { target: r[0] }) },
  repaint: { action: "repaint", parse: (r) => ok({ target: r[0] }) },
  regenerate: { action: "regenerate", parse: (r) => ok({ target: r[0] }) },
  restore: { action: "restore", parse: (r) => ok({ target: r[0] }) },
  audit: { action: "audit", parse: () => ok() },
  purge: { action: "purge", parse: (r) => ok({ confirm: r[0] === "confirm" }) },
  "style list": { action: "style.list", parse: () => ok() },
  "style preview": {
    action: "style.preview",
    parse: (_r, body) => {
      const rules = parseRules(body);
      return rules ? ok({ rules }) : { ok: false, text: RULE_HINT };
    },
  },
  "style add": {
    action: "style.add",
    parse: (_r, body) => {
      const rules = parseRules(body);
      return rules ? ok({ rules }) : { ok: false, text: RULE_HINT };
    },
  },
  "style remove": { action: "style.remove", parse: (r) => ok({ ids: r }) },
  "style reset": { action: "style.reset", parse: () => ok() },
};

const USAGE =
  "Usage: /badge status [all|<target>] | repaint [this|<target>|profile] | audit | " +
  "regenerate [this|<target>|profile] | restore [this|<target>] | purge confirm | style list | style preview <json> | " +
  "style add <json> | style remove <id…> | style reset";

// The engine for the channel the command came from, else the only engine.
export function engineFor(engines: Engine[], channel: string | undefined): Engine | null {
  const ch = String(channel ?? "").toLowerCase();
  return (
    engines.find((e) => e.provider.id === ch) ??
    (engines.length === 1 ? (engines[0] ?? null) : null)
  );
}

// The chat's own target: `from`/`to` carry `group:<id>` (optionally channel-prefixed).
function chatTarget(engine: Engine | null, ctx: BadgeCommandContext): TargetRef | null {
  if (!engine) {
    return null;
  }
  for (const v of [ctx.from, ctx.to]) {
    const m = /^(?:[a-z0-9-]+:)?group:(.+)$/i.exec(String(v ?? "").trim());
    if (m) {
      return { kind: "group", idLower: (m[1] as string).toLowerCase() };
    }
  }
  return null;
}

export function createBadgeCommand(deps: BadgeCommandDeps) {
  const run = createActions({ allowGroupMembers: () => true, ...deps });
  return async function handle(ctx: BadgeCommandContext): Promise<{ text: string }> {
    if (deps.engines().length === 0) {
      return { text: "model-badge is not running." };
    }
    const engine = engineFor(deps.engines(), ctx.channelId ?? ctx.channel);
    const raw = String(ctx.args ?? "").trim();
    const words = raw.split(/\s+/).filter(Boolean);
    const [first = "status"] = words;
    const name = first === "style" ? `style ${words[1] ?? "list"}` : first;
    const sub = SLASH_SUBCOMMANDS[name];
    if (!sub) {
      return { text: USAGE };
    }
    const rest = words.slice(first === "style" ? 2 : 1);
    const body = first === "style" ? raw.replace(/^style\s+\S+\s*/, "") : rest.join(" ");
    const parsed = sub.parse(rest, body);
    if (!parsed.ok) {
      return { text: parsed.text };
    }
    const actx: ActionContext = {
      senderId: ctx.senderId ? String(ctx.senderId) : null,
      engine,
      here: chatTarget(engine, ctx),
    };
    return { text: (await run(sub.action, parsed.args, actx)).text };
  };
}
