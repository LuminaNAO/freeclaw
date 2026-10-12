import type { Engine } from "./core/engine.js";
import { targetKey, type TargetRef } from "./core/provider.js";
import type { Steering } from "./core/steering.js";
import type { Requester, StyleRuleInput } from "./core/style.js";

// `/badge` (ARCH §5.3, §2a.3, §2b.4). Commands never call a provider: mutating commands
// only change engine state, so each engine stays the single writer.

export type BadgeCommandContext = {
  senderId?: string;
  channel: string;
  channelId?: string;
  args?: string;
  from?: string;
  to?: string;
};

export type BadgeCommandDeps = {
  engines: () => Engine[];
  steering: () => Steering | null;
  operators: () => string[];
  purge: () => Promise<void>;
  now?: () => number;
};

const USAGE =
  "Usage: /badge status [all] | repaint [this|<target>|profile] | audit | regenerate [this|<target>] | " +
  "purge confirm | style list | style preview <json> | style add <json> | style remove <id…> | style reset";

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

// The engine for the channel the command came from, else the only engine.
function engineFor(engines: Engine[], ctx: BadgeCommandContext): Engine | null {
  const ch = (ctx.channelId ?? ctx.channel ?? "").toLowerCase();
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

function parseRules(text: string): StyleRuleInput[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    return (Array.isArray(v) ? v : [v]) as StyleRuleInput[];
  } catch {
    return null;
  }
}

export function createBadgeCommand(deps: BadgeCommandDeps) {
  const now = deps.now ?? (() => Date.now());
  return async function handle(ctx: BadgeCommandContext): Promise<{ text: string }> {
    const engines = deps.engines();
    if (engines.length === 0) {
      return { text: "model-badge is not running." };
    }
    const isOperator = Boolean(ctx.senderId) && deps.operators().includes(String(ctx.senderId));
    const engine = engineFor(engines, ctx);
    const here = chatTarget(engine, ctx);
    const raw = String(ctx.args ?? "").trim();
    const [sub = "status", ...rest] = raw.split(/\s+/).filter(Boolean);
    const arg = rest[0];
    const who: Requester = { senderId: ctx.senderId ?? null, fromTargetId: here?.idLower ?? null };

    if (sub === "style") {
      const steering = deps.steering();
      if (!steering) {
        return { text: "model-badge is not running." };
      }
      const action = arg ?? "list";
      const body = raw.replace(/^style\s+\S+\s*/, "");
      if (action === "list") {
        const r = await steering.list();
        const lines = [...r.config, ...r.rules].map(
          (x) =>
            `${x.id}: match ${JSON.stringify(x.match)} → ${JSON.stringify(x.set)}${x.note ? ` (${x.note})` : ""}`,
        );
        return { text: lines.length ? lines.join("\n") : "No style rules." };
      }
      if (action === "preview" || action === "add") {
        const rules = parseRules(body);
        if (!rules) {
          return {
            text: 'Give the rule as JSON, e.g. {"match":{"provider":"anthropic"},"set":{"tone":"light"}}',
          };
        }
        if (action === "preview") {
          const p = await steering.preview(rules, who);
          if (!p.ok) {
            return { text: `Rejected: ${p.error}` };
          }
          const lines = p.changes.map((c) => `${c.provider} ${c.target}: ${c.models.join(", ")}`);
          return {
            text: `${p.changes.length} target(s) would change, ${p.unaffectedTargets} unaffected.\n${lines.join("\n")}`.trim(),
          };
        }
        const a = await steering.add(rules, who);
        return {
          text: a.ok ? `Added ${a.added.map((r) => r.id).join(", ")}.` : `Rejected: ${a.error}`,
        };
      }
      if (action === "remove") {
        const r = await steering.remove(rest.slice(1), who);
        return { text: r.ok ? `Removed ${r.removed.join(", ")}.` : `Not removed: ${r.error}` };
      }
      if (action === "reset") {
        const r = await steering.reset(who);
        return { text: r.ok ? "All stored style rules removed." : `Not reset: ${r.error}` };
      }
      return { text: USAGE };
    }

    if (!isOperator) {
      return { text: "This /badge command is for operators only." };
    }

    const keyOf = (word: string | undefined): string | null => {
      if (!word || word === "this") {
        return here ? targetKey(here) : null;
      }
      if (word === "profile") {
        return "profile:profile";
      }
      return `group:${word.replace(/^group:/i, "").toLowerCase()}`;
    };

    if (sub === "status") {
      const lines: string[] = [];
      for (const e of engines) {
        const st = e.status();
        if (arg !== "all" && here && e === engine) {
          const s = e.targetSummary(targetKey(here));
          if (!s) {
            lines.push("This chat is not a tracked target yet.");
            continue;
          }
          lines.push(
            `Desired: ${"error" in s.desired ? s.desired.error : `${s.desired.mark} (${s.desired.model}, ${s.desired.base} base)`}`,
            `Showing: ${s.applied ? `${s.applied.mark} (${s.applied.model})` : "nothing recorded"}${s.converged ? " ✓" : ""}`,
          );
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
          continue;
        }
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
      return { text: lines.join("\n") };
    }

    if (sub === "repaint" || sub === "regenerate") {
      if (!engine) {
        return { text: "Run this in the channel whose avatar you mean." };
      }
      const key = keyOf(arg);
      if (!key) {
        return { text: `Usage: /badge ${sub} this|<target>|profile` };
      }
      const r = sub === "repaint" ? await engine.repaint(key) : await engine.regenerate(key);
      return {
        text: r.ok
          ? `${sub === "repaint" ? "Repaint" : "Regeneration"} queued.`
          : `Not queued: ${r.message}.`,
      };
    }

    if (sub === "audit") {
      const out: string[] = [];
      for (const e of engines) {
        const a = await e.audit();
        out.push(
          `${e.provider.id}: ${a.converged}/${a.targets} converged, ${a.mismatched.length} pending, ` +
            `${a.parked.length} parked, ${a.assetsMissing} assets missing (role ${a.role})`,
        );
      }
      return { text: out.join("\n") };
    }

    if (sub === "purge") {
      if (arg !== "confirm") {
        return {
          text: "This stops model-badge and deletes its generated assets and state. Run /badge purge confirm.",
        };
      }
      await deps.purge();
      return {
        text: "model-badge stopped; its cache and state were removed. Avatars were left as they are.",
      };
    }

    return { text: USAGE };
  };
}
