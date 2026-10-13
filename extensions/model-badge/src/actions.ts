import type { Engine } from "./core/engine.js";
import { targetKey, type TargetRef } from "./core/provider.js";
import type { Sample, Steering } from "./core/steering.js";
import type { Requester, StyleRule, StyleRuleInput } from "./core/style.js";

// ARCH §2c.1, §2c.2: every `/badge` subcommand and every agent-tool action runs through
// this one dispatcher, so both have the same effect and result. Authority is decided
// here, on the authenticated sender id the gateway passes in (never on anything the
// model writes): operators may do everything; group members may act on the group they
// are in (style rules with that group's targetId, repaint, regenerate, status, audit);
// global rules, other groups, the profile and purge are operator-only.

export const ACTIONS = [
  "status",
  "style.list",
  "style.preview",
  "style.add",
  "style.remove",
  "style.reset",
  "repaint",
  "regenerate",
  "audit",
  "purge",
] as const;
export type Action = (typeof ACTIONS)[number];

export function isAction(v: unknown): v is Action {
  return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}

export type ActionArgs = {
  // repaint/regenerate/status: "this" (default), a target id, or "profile".
  target?: string;
  // status: every target rather than this chat's.
  all?: boolean;
  rules?: StyleRuleInput[];
  ids?: string[];
  // purge: must be true.
  confirm?: boolean;
};

// Who is asking and from where. `senderId` is the gateway's authenticated sender id;
// `here` is the chat the request came from, when it is a badge target of `engine`.
export type ActionContext = {
  senderId: string | null;
  engine: Engine | null;
  here: TargetRef | null;
};

export type ActionResult = {
  ok: boolean;
  text: string;
  details: Record<string, unknown>;
  // style.preview: rendered samples (the tool attaches them as images).
  samples?: Sample[];
};

export type ActionDeps = {
  engines: () => Engine[];
  steering: () => Steering | null;
  operators: () => string[];
  allowGroupMembers: () => boolean;
  purge: () => Promise<void>;
  now?: () => number;
};

const WHO_OPERATORS = "an operator (a sender id listed in the plugin's `operators`)";

function refuse(reason: string, who: string, extra: Record<string, unknown> = {}): ActionResult {
  const text = `Refused: ${reason}. Who can: ${who}.`;
  return { ok: false, text, details: { ok: false, refused: true, reason, whoCan: who, ...extra } };
}

function fail(text: string, details: Record<string, unknown> = {}): ActionResult {
  return { ok: false, text, details: { ok: false, error: text, ...details } };
}

function ago(now: number, t: unknown): string {
  if (typeof t !== "number") {
    return "?";
  }
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 120
    ? `${s}s ago`
    : s < 7200
      ? `${Math.round(s / 60)}m ago`
      : `${Math.round(s / 3600)}h ago`;
}

type Role =
  | { kind: "operator" }
  | { kind: "member"; group: string }
  | { kind: "none"; why: "no-sender" | "not-in-group" | "members-off" };

export function roleOf(
  ctx: ActionContext,
  deps: Pick<ActionDeps, "operators" | "allowGroupMembers">,
): Role {
  if (ctx.senderId && deps.operators().includes(ctx.senderId)) {
    return { kind: "operator" };
  }
  if (!ctx.senderId) {
    return { kind: "none", why: "no-sender" };
  }
  if (!ctx.here || ctx.here.kind !== "group") {
    return { kind: "none", why: "not-in-group" };
  }
  if (!deps.allowGroupMembers()) {
    return { kind: "none", why: "members-off" };
  }
  return { kind: "member", group: ctx.here.idLower };
}

function whyText(r: Extract<Role, { kind: "none" }>, what: string): string {
  switch (r.why) {
    case "no-sender":
      return `${what} is for operators only (no authenticated sender)`;
    case "not-in-group":
      return `${what} outside a group chat is for operators only`;
    case "members-off":
      return `${what} is for operators only (steering.allowGroupMembers is off)`;
  }
}

const WHO_MEMBER =
  "an operator, or a member of that group asking from inside it (steering.allowGroupMembers)";

export function createActions(deps: ActionDeps) {
  const now = deps.now ?? (() => Date.now());

  // The target key a word names, relative to the chat the request came from.
  function keyOf(ctx: ActionContext, word: string | undefined): string | null {
    const w = String(word ?? "").trim();
    if (!w || w === "this") {
      return ctx.here ? targetKey(ctx.here) : null;
    }
    if (w === "profile") {
      return "profile:profile";
    }
    return `group:${w.replace(/^group:/i, "").toLowerCase()}`;
  }

  // Members act on their own group only; operators on any target.
  function scopeCheck(role: Role, key: string, what: string): ActionResult | null {
    if (role.kind === "operator") {
      return null;
    }
    if (role.kind === "none") {
      return refuse(whyText(role, what), WHO_MEMBER);
    }
    if (key !== `group:${role.group}`) {
      return refuse(
        key === "profile:profile"
          ? `${what} of the account's profile picture is for operators only`
          : `${what} of another group is for operators only; members act on the group they are in`,
        key === "profile:profile" ? WHO_OPERATORS : WHO_MEMBER,
      );
    }
    return null;
  }

  function engineOr(ctx: ActionContext): Engine | null {
    const engines = deps.engines();
    return ctx.engine ?? (engines.length === 1 ? (engines[0] ?? null) : null);
  }

  function summaryLines(e: Engine, key: string): { lines: string[]; summary: unknown } {
    const s = e.targetSummary(key);
    if (!s) {
      return { lines: ["This chat is not a tracked target yet."], summary: null };
    }
    const lines = [
      `Desired: ${"error" in s.desired ? s.desired.error : `${s.desired.mark} (${s.desired.model}, ${s.desired.base} base)`}`,
      `Showing: ${s.applied ? `${s.applied.mark} (${s.applied.model})` : "nothing recorded"}${s.converged ? " ✓" : ""}`,
    ];
    if (s.parked) {
      lines.push(
        `Parked: ${s.parked.reason} since ${ago(now(), s.parked.since)} — ${s.parked.message}`,
      );
    }
    if (s.waiting) {
      lines.push(`Waiting: ${s.waiting.reason}`);
    }
    if (s.queuePosition >= 0) {
      lines.push(`Queued at position ${s.queuePosition + 1}`);
    }
    const ig = e.status().imageGen;
    lines.push(`Image generation ${ig.state}`);
    return { lines, summary: { ...s, imageGen: ig.state } };
  }

  async function status(ctx: ActionContext, args: ActionArgs, role: Role): Promise<ActionResult> {
    const engines = deps.engines();
    const here = ctx.here && ctx.engine ? targetKey(ctx.here) : null;
    const wantAll = args.all === true || (!here && !args.target);
    if (role.kind !== "operator") {
      if (role.kind === "none") {
        return refuse(whyText(role, "status"), WHO_MEMBER);
      }
      if (args.all) {
        return refuse("status of every target is for operators only", WHO_OPERATORS);
      }
    }
    if (!wantAll) {
      const key = args.target ? keyOf(ctx, args.target) : here;
      const e = engineOr(ctx);
      if (!key || !e) {
        return fail("Run this in the chat whose avatar you mean, or name a target.");
      }
      const denied = scopeCheck(role, key, "status");
      if (denied) {
        return denied;
      }
      const { lines, summary } = summaryLines(e, key);
      return { ok: true, text: lines.join("\n"), details: { ok: true, target: key, summary } };
    }
    const lines: string[] = [];
    const providers: Record<string, unknown> = {};
    for (const e of engines) {
      const st = e.status();
      providers[e.provider.id] = {
        role: st.role,
        targets: e.knownTargets().length,
        parked: Object.keys(st.parked).length,
        cache: st.cache,
        queue: st.queue,
        imageGen: st.imageGen,
        health: st.health,
      };
      const captcha = st.health.captcha as { since?: number; action?: string } | undefined;
      const health = Object.entries(st.health).filter(([k]) => k !== "captcha");
      lines.push(
        ...[
          captcha
            ? `⚠️ ${e.provider.id}: challenge required since ${ago(now(), captcha.since)}: ${captcha.action}`
            : null,
          `${e.provider.id}: role ${st.role}; targets ${e.knownTargets().length}; parked ${Object.keys(st.parked).length}`,
          `  assets ${String(st.cache.present)}/${String(st.cache.required)}${st.cache.builtAt ? `, built ${ago(now(), st.cache.builtAt)}` : ""}`,
          `  queue ${st.queue.length}${st.queue.pausedUntil ? `, paused (${st.queue.pauseReason})` : ""}`,
          `  image generation ${st.imageGen.state}: ${st.imageGen.usedToday}/${st.imageGen.maxPerDay} used today`,
          `  health ${health.length ? health.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("; ") : "ok"}`,
          Object.keys(st.notices.unavailableModels).length
            ? `  unavailable models in use: ${Object.keys(st.notices.unavailableModels).join(", ")}`
            : null,
        ].filter((x): x is string => Boolean(x)),
      );
    }
    return { ok: true, text: lines.join("\n"), details: { ok: true, providers } };
  }

  async function repaintOrRegenerate(
    kind: "repaint" | "regenerate",
    ctx: ActionContext,
    args: ActionArgs,
    role: Role,
  ): Promise<ActionResult> {
    // Authority first: a refused requester learns nothing about targets or usage.
    if (role.kind === "none") {
      return refuse(whyText(role, kind), WHO_MEMBER);
    }
    const e = engineOr(ctx);
    if (!e) {
      return fail("Run this in the channel whose avatar you mean.");
    }
    const key = keyOf(ctx, args.target);
    if (!key) {
      return fail(`Usage: /badge ${kind} this|<target>|profile`);
    }
    const denied = scopeCheck(role, key, kind);
    if (denied) {
      return denied;
    }
    const r = kind === "repaint" ? await e.repaint(key) : await e.regenerate(key);
    if (!r.ok) {
      return fail(`Not queued: ${r.message}.`, { target: key });
    }
    return {
      ok: true,
      text: `${kind === "repaint" ? "Repaint" : "Regeneration"} queued.`,
      details: { ...r, ok: true, target: key },
    };
  }

  async function audit(ctx: ActionContext, role: Role): Promise<ActionResult> {
    if (role.kind === "none") {
      return refuse(whyText(role, "audit"), WHO_MEMBER);
    }
    if (role.kind === "member") {
      const e = engineOr(ctx);
      const key = `group:${role.group}`;
      const s = e?.targetSummary(key);
      if (!e || !s) {
        return fail("This chat is not a tracked target yet.");
      }
      const state = s.converged
        ? "converged"
        : s.parked
          ? `parked (${s.parked.reason})`
          : "pending";
      return {
        ok: true,
        text: `${e.provider.id}: this group is ${state}`,
        details: {
          ok: true,
          target: key,
          converged: s.converged,
          parked: s.parked,
          waiting: s.waiting,
        },
      };
    }
    const out: string[] = [];
    const providers: Record<string, unknown> = {};
    for (const e of deps.engines()) {
      const a = await e.audit();
      providers[e.provider.id] = a;
      out.push(
        `${e.provider.id}: ${a.converged}/${a.targets} converged, ${a.mismatched.length} pending, ` +
          `${a.parked.length} parked, ${a.assetsMissing} assets missing (role ${a.role})`,
      );
    }
    return { ok: true, text: out.join("\n"), details: { ok: true, providers } };
  }

  function ruleLine(x: StyleRule) {
    return `${x.id}: match ${JSON.stringify(x.match)} → ${JSON.stringify(x.set)}${x.note ? ` (${x.note})` : ""}`;
  }

  async function style(
    action: Extract<Action, `style.${string}`>,
    ctx: ActionContext,
    args: ActionArgs,
    role: Role,
  ): Promise<ActionResult> {
    const steering = deps.steering();
    if (!steering) {
      return fail("model-badge is not running.");
    }
    if (role.kind === "none") {
      return refuse(whyText(role, "steering"), WHO_MEMBER);
    }
    // The requester as steering sees it: the member's own group, never a model-written one.
    const who: Requester = {
      senderId: ctx.senderId,
      fromTargetId: role.kind === "member" ? role.group : (ctx.here?.idLower ?? null),
    };
    const rules = Array.isArray(args.rules) ? args.rules : [];
    switch (action) {
      case "style.list": {
        const r = await steering.list();
        // Members see global rules and their own group's, not other groups'.
        const visible = (x: StyleRule) =>
          role.kind === "operator" || !x.match.targetId || x.match.targetId === role.group;
        const config = r.config.filter(visible);
        const stored = r.rules.filter(visible);
        const lines = [...config, ...stored].map(ruleLine);
        return {
          ok: true,
          text: lines.length ? lines.join("\n") : "No style rules.",
          details: { ok: true, config, rules: stored },
        };
      }
      case "style.preview": {
        if (rules.length === 0) {
          return fail(
            'Give the rule as JSON, e.g. {"match":{"provider":"anthropic"},"set":{"tone":"light"}}',
          );
        }
        const p = await steering.preview(rules, who);
        if (!p.ok) {
          return { ok: false, text: `Rejected: ${p.error}`, details: { ...p } };
        }
        const { samples, ...rest } = p;
        const lines = p.changes.map((c) => `${c.provider} ${c.target}: ${c.models.join(", ")}`);
        return {
          ok: true,
          text: `${p.changes.length} target(s) would change, ${p.unaffectedTargets} unaffected.\n${lines.join("\n")}`.trim(),
          details: { ...rest, samples: samples.map((s) => s.label) },
          samples,
        };
      }
      case "style.add": {
        if (rules.length === 0) {
          return fail(
            'Give the rule as JSON, e.g. {"match":{"provider":"anthropic"},"set":{"tone":"light"}}',
          );
        }
        const a = await steering.add(rules, who);
        return a.ok
          ? { ok: true, text: `Added ${a.added.map((r) => r.id).join(", ")}.`, details: { ...a } }
          : { ok: false, text: `Rejected: ${a.error}`, details: { ...a } };
      }
      case "style.remove": {
        const r = await steering.remove(Array.isArray(args.ids) ? args.ids.map(String) : [], who);
        return r.ok
          ? { ok: true, text: `Removed ${r.removed.join(", ")}.`, details: { ...r } }
          : { ok: false, text: `Not removed: ${r.error}`, details: { ...r } };
      }
      case "style.reset": {
        if (role.kind !== "operator") {
          return refuse("removing every style rule is for operators only", WHO_OPERATORS);
        }
        const r = await steering.reset(who);
        return r.ok
          ? { ok: true, text: "All stored style rules removed.", details: { ...r } }
          : { ok: false, text: `Not reset: ${r.error}`, details: { ...r } };
      }
    }
    return fail("unknown style action");
  }

  return async function run(
    action: Action,
    args: ActionArgs,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    if (deps.engines().length === 0) {
      return fail("model-badge is not running.");
    }
    const role = roleOf(ctx, deps);
    switch (action) {
      case "status":
        return status(ctx, args, role);
      case "repaint":
      case "regenerate":
        return repaintOrRegenerate(action, ctx, args, role);
      case "audit":
        return audit(ctx, role);
      case "purge": {
        // Destructive: operator-only by slash command and tool alike (§2c.1).
        if (role.kind !== "operator") {
          return refuse(
            "purge is for operators only (it deletes every generated asset and all state)",
            WHO_OPERATORS,
          );
        }
        if (args.confirm !== true) {
          return fail(
            "This stops model-badge and deletes its generated assets and state. Run /badge purge confirm.",
            { needsConfirm: true },
          );
        }
        await deps.purge();
        return {
          ok: true,
          text: "model-badge stopped; its cache and state were removed. Avatars were left as they are.",
          details: { ok: true },
        };
      }
      default:
        return style(action, ctx, args, role);
    }
  };
}

export type RunAction = ReturnType<typeof createActions>;
