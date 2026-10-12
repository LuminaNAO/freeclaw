# model-badge

Keeps each chat target's avatar showing the badge of the model its session will use
next. Design: [ARCH.md](./ARCH.md) (operator-owned).

**No art is shipped.** Every picture is generated on the host when the extension runs:
a per-target base from built-in parametric motifs (or a configured image generator),
with the model's mark composited on top. Assets are generated when a model or target
appears and pruned when it goes away.

## Layout

```
index.ts                      plugin entry: service, /badge, model_badge_style tool, session_start nudge
openclaw.plugin.json          config schema + uiHints
src/runtime.ts                wires the core to freeclaw (paths, providers, rasteriser, image backend)
src/core/                     channel-agnostic core (never imports a provider)
  engine.ts                   single writer: lease, desired-state reconcile, debounce, paced queue,
                              rate-limit/captcha/outage pauses, parking, generate/prune lifecycle
  desired.ts                  pure desired state (model → mark, target → base, asset hash)
  motif.ts palette.ts         vector base generator (rings, waves, facets, dots)
  badges.ts color.ts          marks: rules, fallback letters, WCAG contrast guard
  style.ts steering.ts        style rules (style.json), validation, authority, preview/add/remove/reset
  catalog.ts                  model grouping: provider/family resolution and aliases
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
  },
  "operators": ["<sender id>"],
  "badges": [{ "pattern": "opus", "letter": "O", "color": "#9B59D0" }],
  "targets": { "<target id>": { "motif": "waves", "palette": "ocean" } },
  "steering": { "allowGroupMembers": false, "rules": [] },
  "imageGen": null, // or { "kind": "openai-images", "baseUrl", "model", "apiKey": <SecretRef> }
  // or { "kind": "command", "command": "/abs/path", "args": [] }
}
```

State lives in `<gateway state dir>/plugins/model-badge/`: `style.json` (shared) and one
directory per provider with `applied.json`, `status.json`, `writer.lease`, `assets/` and
`bases/`. The Signal daemon opens avatars by path, so this directory must be readable by
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
| target removed          | provider listing at startup/periodic, or a `not-found` answer to a write                                                                                                                                  |
| input change            | **watcher** — gateway config (default model, this plugin's config) and `style.json`                                                                                                                       |

## Commands

`/badge status [all] | repaint [this|<target>|profile] | audit | regenerate [this|<target>] | purge confirm`
(operators only, matched on the authenticated sender id), and
`/badge style list | preview <json> | add <json> | remove <id…> | reset`
(authority per ARCH §2a.4). The agent tool `model_badge_style` offers the same steering
actions; it previews with rendered samples and adds only after the user confirms.

## Rasteriser

`rsvg-convert` (librsvg) if present, else ImageMagick `magick`. With neither, health shows
`renderer-missing` and the writer stays idle.

## Tests

`pnpm test:extensions extensions/model-badge`. The core suite runs against the Signal
provider and a fake second provider. The real-render tests use the host's rasteriser;
on a host without one they are skipped with the explicit reason
`renderer unavailable: neither rsvg-convert nor magick is on PATH`, which CI reports as a
skipped test — install librsvg to run them.
