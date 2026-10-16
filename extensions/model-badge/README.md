# model-badge

Keeps each chat target's avatar showing the badge of the model its session will use
next. Design: [ARCH.md](./ARCH.md) (operator-owned).

**No art is shipped.** Every picture is generated on the host when the extension runs:
a per-target base from built-in parametric motifs (or a configured image generator),
with the model's mark composited on top. Assets are generated when a model or target
appears and pruned when it goes away.

## Layout

```
index.ts                      plugin entry: service, /badge, model_badge tool (+ model_badge_style alias), session_start nudge
openclaw.plugin.json          config schema + uiHints
src/actions.ts                one action dispatcher + authority for /badge and the tool (ARCH §2c.1, §2c.2)
src/commands.ts src/tool.ts   /badge parser and the model_badge agent tool, both thin over actions.ts
src/runtime.ts                wires the core to freeclaw (paths, providers, rasteriser, image backend)
src/core/                     channel-agnostic core (never imports a provider)
  engine.ts                   single writer: lease, desired-state reconcile, debounce, paced queue,
                              rate-limit/captcha/outage pauses, parking, generate/prune lifecycle
  desired.ts                  pure desired state (model → mark, target → base, asset hash)
  motif.ts palette.ts         vector base generator (rings, waves, facets, dots)
  badges.ts color.ts          marks: rules, fallback letters, WCAG contrast guard
  style.ts steering.ts        style rules (style.json), validation, authority, preview/add/remove/reset
  catalog.ts                  model grouping: provider/family resolution and aliases
  adopted.ts                  a group's own artwork, captured once on first sight (ARCH §2c.8)
  marked.ts                   detects our mark in a picture, so marked artwork is never adopted (§2c.9)
  baseart.ts                  BaseArtGenerator: vector, openai-images, command; stored image bases
  cache.ts render.ts          asset cache keyed by generator inputs; rasteriser seam
  provider.ts                 BadgeProvider interface
src/providers/registry.ts     provider registry (config `providers` picks from it)
src/providers/signal/         Signal provider on freeclaw's own Signal client (HTTP + unix socket)
```

## Configuration

`plugins.entries.model-badge.config`:

```jsonc
{
  "providers": ["signal"],
  "signal": {
    "accountId": "default", // freeclaw Signal account; the daemon is resolved from it
    "profileSessionKey": null, // optional: the account's own profile avatar follows this session
    "profileBaseImage": null, // optional absolute path to your own profile picture
    "groups": { "mode": "all", "ids": [] }, // all | include | exclude: which groups this agent paints
  },
  "operators": ["<sender id>"],
  "badges": [{ "pattern": "opus", "letter": "O", "color": "#9B59D0" }],
  "targets": { "<target id>": { "motif": "waves", "palette": "ocean", "base": "adopt" } }, // base: adopt (default) | generate
  "steering": { "allowGroupMembers": true, "rules": [] }, // false: operator-only
  "imageGen": null, // or { "kind": "openai-images", "baseUrl", "model", "apiKey": <SecretRef> }
  // or { "kind": "command", "command": "/abs/path", "args": [] }
  // limits: "maxPerRun": 16, "maxPerDay": 200, "maxAttempts": 10 (defaults, sized for a
  // local generator; lower them for metered backends)
  // "promptWriter": { "enabled": true, "model": null, "timeoutMs": 60000, "memory": true }
  // (inside imageGen; ARCH §2c.11, see "Scenes for new groups")
}
```

State lives in `<gateway state dir>/plugins/model-badge/`: `style.json` (shared) and one
directory per provider with `applied.json`, `status.json`, `writer.lease`, `assets/` and
`adopted/` (groups' own artwork, §2c.8), `bases/` (stored image bases plus `generations.json`, the per-target regenerate counter), `scenes/scenes.json` (per-target written scenes, §2c.11). The Signal daemon opens avatars by path, so this directory must be readable by
the daemon's user, and the daemon must be local (loopback HTTP or the unix socket).

## Triggers (ARCH §5.2)

The set is closed. Which ones come from plugin events and which from the watcher:

| Trigger                 | Source                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startup                 | the plugin service start (`registerService`)                                                                                                                                                              |
| periodic reconcile      | the engine's own timer (`timing.reconcileIntervalMs`)                                                                                                                                                     |
| session model change    | **store watcher** — freeclaw emits no plugin event for `/model`, `sessions.patch` or override resets, so the sessions store is `stat`ed every `timing.watchMs` and the per-session override pair compared |
| models-available change | **store watcher** — no plugin event exists; the agent's `models.json` is watched the same way                                                                                                             |
| target created          | plugin event `session_start` (early nudge) confirmed by the watcher; groups that never get a session are found by the provider listing at startup/periodic                                                |
| group named / renamed   | plugin event `group_memory_created` (group-memory ARCH §8): records the group's name and asks the agent for its scene (§2c.11)                                                                            |
| target removed          | provider listing at startup/periodic, or a `not-found` answer to a write                                                                                                                                  |
| input change            | **watcher** — gateway config (default model, this plugin's config) and `style.json`                                                                                                                       |

## Image first (ARCH §2c.4)

With `imageGen` configured every base is an image from the generator, the profile included
(portrait-safe prompt, unless `signal.profileBaseImage` is set). A failed probe does not pin
the extension to vector: it is retried with backoff on each pass (health `imageGen:
retrying`) and bases upgrade as soon as it answers, without a restart. A target whose image
is not ready (cap reached, queued, failing) keeps the avatar it has; only a target with no
avatar of ours gets a vector base, upgraded when its image exists. Without `imageGen`, vector
art is the base generator (health `imageGen: unconfigured`).

`regenerate` bumps the target's generation counter; the image seed is
`sha256(provider:target:generation)`, so the same style gives a new picture. The old base is
pruned once the new one is applied. A style change keeps the counter (same seed, new prompt).

## A group's own artwork is kept (ARCH §2c.8)

The first time a group target is seen, the avatar it already shows is read once (Signal:
`getAvatar`). If it is not one of ours (every asset we render carries a PNG text stamp), it
is captured — format-guarded, kept whole — as the group's **adopted base**, and the model
mark is composited on top of it once, in the corner mark position (ARCH §2c.9). An adopted
base is drawn **full-frame**: it fills the whole square, with no inset frame, no blurred
background and no darkening (a non-square source is centre-cropped, after the format guard).
Artwork that already carries our mark — our PNG stamp, our mark found at its corner position
in the decoded picture, or a target we have already painted — is never adopted (recorded as
`none: "ours"`); it keeps the base we last applied or gets a generated one, never a mark on a
mark. The adopted layout tag is `full-v1` (was `contain-v1`), so adopted targets repaint once
after an upgrade and then stay put. No image is generated for it. A target is never
painted before this check. Restyling (motif, palette, prompt) keeps an adopted base; only
`regenerate` replaces it, and `restore` puts it back (the bytes stay in `adopted/`). Both
follow the §2c.2 authority. `targets.<id>.base: generate` turns adoption off for a target;
`adopt` is the default. A target with no avatar, or one showing our own mark, gets a
generated base.

## Scenes for new groups (ARCH §2c.11)

When group memory creates a group's folder (or the group is renamed) it fires the
`group_memory_created` plugin hook. The badge keeps the name and asks the agent to write the
group's scene: one short run through the plugin runtime (`runtime.subagent.run`) in its own
throwaway session, deleted afterwards. The writer's only inputs are the group name and the
top few snippets of the agent's own memory search for it (memory files only; no chat
messages, member names or numbers). It returns one concrete scene of at most 40 words.

What it returns is checked: one line, ≤ 40 words, no quotes, none of the §2c.10 banned words,
no id-like digit runs, no proper noun taken from the group name. A rejected, failed or timed
out answer (default 60 s) falls back to the §2c.10 motif scene. The accepted scene is wrapped
in the same full-bleed template. A member's steering `prompt` still overrides it.

Boundary: the writer runs inside the same agent, so it only sees that agent's memory, and it
is skipped (motif scene) unless `imageGen` is a local command or an `openai-images` URL on
loopback or a private address, so names and memory never leave the box in a prompt.

The writer is not called for a group on its own adopted artwork (§2c.8), and the outcome is
cached per target, keyed by (name, generation), in `scenes/scenes.json`: the same inputs
never call it twice. A rename or a `regenerate` makes new inputs. Scenes are never logged;
`/badge status` shows the scene and where it came from.

`imageGen.promptWriter`: `enabled` (default true), `model` (`provider/model`, default the
agent's default model), `timeoutMs` (default 60000), `memory` (default true; false sends the
name only).

## Which groups (operator addendum, §2c target selection)

Every member of a Signal group shares the group avatar, so two agents running model-badge in
the same group overwrite each other. `signal.groups` picks the groups this agent drives:
`{ "mode": "all" }` (default), `{ "mode": "include", "ids": [...] }` or
`{ "mode": "exclude", "ids": [...] }` (group ids as `listGroups` reports them, any case).
A group that is not driven is skipped entirely: its avatar is never read or captured
(§2c.8), no base is generated for it and it is never painted; repaint/regenerate/restore on
it say so. The setting is read live, so excluding a group stops writes to it without a
restart; its stored state is kept in case it is included again.

## Talking to the agent, and commands (ARCH §2c.1, §2c.2)

Everything is reachable by asking the agent. The tool `model_badge` has the actions
`status | style.list | style.preview | style.add | style.remove | style.reset | repaint |
regenerate | restore | audit | purge`; `model_badge_style` is an alias that also takes the old short
style actions. `/badge` is the same set as a convenience:

`/badge status [all|<target>] | repaint [this|<target>|profile] | regenerate [this|<target>|profile] |
restore [this|<target>] | audit | purge confirm | style list | style preview <json> | style add <json> | style remove <id…> | style reset`

Both go through one dispatcher, and authority is checked there on the authenticated sender
id the gateway passes in, never on tool arguments. Operators (`operators`) may do
everything. Group members (with `steering.allowGroupMembers`, on by default) may act on the
group they are asking from: style rules with that group's `targetId`, repaint, regenerate,
restore, status and audit of that group. Global rules, other groups, the profile, `status all`,
`style reset` and `purge` are operator-only. A refusal says why and who can.

## Rasteriser

`rsvg-convert` (librsvg) if present, else ImageMagick `magick`. With neither, health shows
`renderer-missing` and the writer stays idle.

## Tests

`pnpm test:extensions extensions/model-badge`. The core suite runs against the Signal
provider and a fake second provider. The real-render tests use the host's rasteriser;
on a host without one they are skipped with the explicit reason
`renderer unavailable: neither rsvg-convert nor magick is on PATH`, which CI reports as a
skipped test — install librsvg to run them.
