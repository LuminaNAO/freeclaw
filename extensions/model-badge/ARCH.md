# model-badge extension — ARCH v2 (fold-in; §2c agentic + image first)

Status: operator-owned. Engineers never edit it; commits name the section.

## 0. What and why

A freeclaw extension (`extensions/model-badge`) that keeps each chat target's avatar showing the badge of the
model its session will use next. It folds in the standalone model-badge rebuild (reconciler, asset cache,
assignment state, Signal provider, `/badge` commands — 114 certified tests) **with one change of principle:**

> **No art is committed. Ever.** Every picture the extension shows is **generated** on the host when the extension
> is turned on, from parameters, and the generated set follows the live world: assets are generated when a model
> or target appears and removed when it goes away.

It must be channel-agnostic: Signal is the first provider; others (e.g. Teams, Telegram) can be added later
behind the same provider interface without touching the core.

## 1. Source

Port from the certified standalone repo (operator supplies it as a read-only reference checkout path in the task
brief). Keep its structure and behaviour (generic core + `BadgeProvider` interface; single writer with lease;
desired-state reconciler; closed event model; rate-limit/captcha/outage pauses; parking; status/health; synthetic
fixtures; real-render tests). Drop: committed SVG/PNG art, `tools/extract-bases`, the artDir/base SVG inputs, the
legacy-state importer and the seed hook. Code style and tests follow freeclaw (TypeScript, vitest), not the
standalone repo's.

## 2. Generated art (replaces base SVGs)

1. **Base avatar per target is generated**, deterministic from a seed: `seed = sha256(providerId + ":" +
targetId)` (never stored in plain form outside the state dir). The seed picks: background gradient (from a
   built-in palette list), and a **generated motif** (built-in parametric SVG shapes defined in code — geometric
   primitives only, e.g. rings, waves, facets, dots; no drawn/imported artwork). Same target → same base forever;
   different targets → visibly different bases.
2. **Badge mark per model is generated**: letter(s), colour and text contrast come from config `badges` rules
   (pattern → `{letter, color}`) with a deterministic fallback for unmatched models: letters derived from the
   model id (first alnum of family, plus a digit/variant letter when needed to disambiguate within the current
   available set), colour from a hash into the palette, text dark/light from WCAG contrast against that colour.
   Unknown/unavailable model → the fixed `?` mark.
3. **Profile target** (optional, per provider account): base is a generated portrait-safe abstract (same
   generator, distinct seed namespace) unless the operator points `profileBaseImage` at a local file — a runtime
   input, never committed.
4. **Operator overrides are runtime config only**: `targets.<targetId>.motif|palette` and `badges` rules. Nothing
   operator-specific is in the repo.
5. Asset identity is unchanged in spirit: `assetHash = sha256(canonicalJSON({ badge: mark, base: baseParams,
renderer: RENDERER_VERSION, size }))` — the hash covers generator inputs, so re-rendering never causes a
   repaint.

## 2a. Steering (users shape the look in plain language)

Users steer the generated look by talking to the agent, e.g. "make Anthropic models light colours and OpenAI
models dark", "Kimi should be green", "use waves for the client group", "bigger letters". Design:

1. **Style rules are data, not code**: an ordered list in the extension's state dir (`style.json`, written only
   through the API below; operator-seeded defaults may also come from config). Each rule:
   `{ id, match: { provider?, family?, modelGlob?, targetId? }, set: { tone?: "light"|"dark", hue?, color?,
letter?, motif?, palette?, letterScale? }, createdBy, createdAt, note }`. Later rules win on conflict; a rule
   never edits another.
2. **Model grouping is resolved, not guessed**: `provider` matches the model's real provider from the model
   catalog (e.g. "anthropic", "openai", "moonshot"), with an alias table in code for common words ("claude" →
   anthropic family, "gpt" → openai family, "kimi" → moonshot). An instruction that matches nothing is rejected
   with the list of known providers/families — never silently applied.
3. **Agent tool**: `model_badge_style` with actions `list | preview | add | remove | reset`. The agent turns the
   user's words into one or more rules, calls `preview` (returns which models/targets change and a rendered
   sample per affected mark, as attachments where the channel allows), and calls `add` only after the user
   confirms. Same via `/badge style list|preview|add|remove|reset` for operators.
4. **Authority**: steering is allowed for operators (config `operators`, authenticated sender id) and, if
   `steering.allowGroupMembers` is set, for members of the group the rule targets (`targetId` rules only). Global
   rules (provider/family/model) are operator-only.
5. **Effect**: a rule change is a generator-input change → affected asset hashes change → incremental rebuild
   (generate new, prune old after grace) → paced repaint of affected targets only. Unaffected targets: zero
   writes.
6. **Contrast guard**: whatever the rule says, the letter colour is chosen for WCAG AA contrast against the
   resulting badge colour; `tone` picks the badge lightness band, not the letter.
7. Tests: grouping by provider (incl. aliases), rule order/override, preview has no side effects, add → only
   affected targets repaint, unknown provider rejected with suggestions, authority (non-operator global rule
   refused, group-member rule scoped to their group), contrast guard holds for every tone.

## 2b. Image generation when available, vector art otherwise

1. **Two base-art backends** behind one interface `BaseArtGenerator { id, available(), generate(target, style) →
bytes }`: `vector` (the built-in parametric SVG generator of §2.1, always available) and `image` (an
   image-generation system). Freeclaw has no built-in image generator, so `image` is **configured**, not assumed:
   `imageGen: { kind: "openai-images" | "command", ... }` — an OpenAI-compatible `/v1/images/generations`
   endpoint (baseUrl, model, size; key by SecretRef only) or a local command (absolute path, args, prompt on
   stdin, PNG on stdout, timeout). No key or prompt ever in argv or logs.
2. **Selection**: if `imageGen` is configured and its probe succeeds at enable/startup (health `imageGen: ok`),
   bases are generated with it; otherwise `vector` (health `imageGen: unavailable|unconfigured`). Per-target
   fallback: an image generation that fails or times out uses `vector` for that target, records the failure, and
   retries image generation on the next periodic pass with backoff (max `imageGen.maxAttempts`).
3. **Only the base is generated.** The model mark (letter disc, colour bar) is always composited by our renderer
   on top — letters are never generated by the image model, so marks stay exact and readable.
4. **Generate once, then cache.** An image base is generated once per (target, style prompt, generator id+model)
   and stored in the state dir; the asset hash covers the base bytes' hash, so a stored base never causes a
   repaint. It is regenerated only when its inputs change (steering changes the target's style prompt, or the
   operator runs `/badge regenerate <target>`). Removing a target removes its stored base (§3.3).
5. **Prompt**: built from a neutral house template plus the target's style (steering §2a may set `motif`/`prompt`
   per target or globally, e.g. "watercolour ocean"), with a seed derived from the target id when the backend
   supports seeds. Prompts never include the group name, member names or chat content.
6. **Cost guard**: image generation is metered; config `imageGen.maxPerDay` (default small) and a per-run cap on
   the turn-on burst (excess targets get `vector` now and are upgraded on later passes). `/badge status` shows
   counts used.
7. **Format guard**: generated bytes are verified (PNG/JPEG signature, decodes, square-cropped and resized to the
   provider's asset size) before use; otherwise treated as a failure → `vector`.
8. Tests: unconfigured → vector; probe fails → vector + health; generator succeeds → image base used and
   composited mark present; generator fails for one target → that target vector, others image; cache hit → no
   second generation; style change → regenerate only that target; daily cap respected; no secret in argv
   (command backend gets the prompt on stdin).

## 2c. Agentic first, image first (v2 — supersedes conflicting lines in §2a–§2b and §5.3)

The extension is driven by talking to the agent. Slash commands stay as a convenience; **no outcome may require
one**. Pictures are **always** real images from the image model when one is configured; the vector generator is a
fallback for hosts with no image model at all.

1. **One agent tool covers everything.** `model_badge` (the §2a.3 `model_badge_style` stays as an alias) with actions
   `status | style.list | style.preview | style.add | style.remove | style.reset | repaint | regenerate | audit`.
   Every `/badge` subcommand has a tool action with the same effect and result; a test enumerates the slash
   subcommands and fails if any has no tool action. `purge` stays operator-only by slash command and tool alike
   (destructive).
2. **Authority** is checked inside the action on the authenticated sender id the gateway passes to the tool, never
   on anything the model writes. Operators: everything. **Group members: everything scoped to the group they are in
   — style rules with that group's `targetId`, `repaint`/`regenerate` of that group, `status` of that group.**
   Global rules (provider/family/model) and other groups: operators only. `steering.allowGroupMembers` now
   **defaults to true**; setting it false restores operator-only.
3. **Regenerate gives a new picture.** Each target has a generation counter in the state dir (starts 0);
   `regenerate` increments it. The image seed is `sha256(providerId + ":" + targetId + ":" + generation)`, so the
   same style regenerated yields a different image; the stored base for the old generation is pruned after the
   new one is applied. A style change does not bump the counter (same seed, new prompt).
4. **Image first.** When `imageGen` is configured, every base is an image base:
   - The probe is retried with backoff (startup, then each periodic pass) — a probe that fails at startup does not
     pin the extension to vector; health shows `imageGen: retrying` until it succeeds.
   - A target whose image is not ready yet (cap reached, generation queued or failing) **keeps the avatar it has**;
     it is painted with a vector base only if it has no avatar of ours at all, and is upgraded to the image base as
     soon as one exists. A target never goes from an image base back to vector because of a transient failure.
   - Defaults sized for a local generator: `maxPerRun` 16, `maxPerDay` 200, `maxAttempts` 10 with backoff capped
     at 30 min. Operators may lower them for metered backends.
   - Only when `imageGen` is not configured is `vector` the base generator (health `imageGen: unconfigured`).
5. **Profile target** uses the image generator too (portrait-safe abstract prompt) unless `profileBaseImage` is set.
6. **Agent awareness.** The tool description tells the agent it can restyle, repaint and regenerate on a member's
   request, and to preview before adding rules. A refusal names the reason and who can do it.
7. Tests: slash/tool parity enumeration; member allowed for own group and refused for another group and for global
   rules; operator allowed everywhere; regenerate changes the seed and the image request; image-first: probe failure
   then recovery upgrades bases without a restart; capped target keeps its existing avatar; a target with no avatar
   gets vector then upgrades; unconfigured → vector.
8. **A group's own artwork is kept.** When the extension first sees a target that already has an avatar not made by
   us, it captures those bytes once (format-guarded, square-cropped) as the target's **adopted base**, stored in the
   state dir with `source: adopted`. An adopted base is the background for that target; the mark is composited on
   top. Image generation is not used for it. A style change from a group member does **not** replace an adopted base;
   only an explicit `regenerate` (tool or slash, same authority as §2c.2) does, and the adopted bytes are kept on
   disk so `restore` (new tool action, same authority) puts them back. Operator config `targets.<id>.base: adopt |
   generate` overrides per target. Tests: first sight adopts; restyle keeps adopted; regenerate replaces and restore
   brings it back; a target with no avatar or with our own mark gets a generated base.

9. **Adopted artwork is full-frame, never inset (operator, 2026-10-13 live finding).** §2c.8's "contain on a
   blurred fill" produced a half-size copy of the artwork floating over a blurred copy of itself, and re-badged
   artwork that already carried a mark. Both are defects. Rules:
   - An adopted base is drawn **full-frame** (square, fills the whole 512x512). No inset, no blurred background, no
     darkening. Source avatars are already square; a non-square source is centre-cropped (slice) to a square, but only
     after the format guard.
   - The model mark (colour + letter) is composited on top **once**, in the corner mark position only. No second badge.
   - **Already-marked artwork is not adopted.** Before adopting, detect our own mark (known corner mark region match,
     or a prior-applied record for that target) and record `none: "ours"`; such a target gets the state-dir base we
     last applied instead, or a generated base, never a mark stacked on a mark.
   - Layout tag changes from `contain-v1` to `full-v1`, so existing adopted targets repaint once.
   Tests: adopted base renders full-frame (pixel check at the centre and the four corners outside the mark); no blur
   filter in the SVG; mark appears exactly once; already-marked source is refused as a base; layout tag bump repaints
   once and is then idempotent.

## 3. Lifecycle (generated and removed as the world changes)

1. **Turn on** (`plugins.entries.model-badge.enabled` + provider config): first reconcile generates the required
   set — every live target × every badge mark of every available model, plus `?` — then paints mismatches. Paced.
2. **Model added** to the available set → its mark is generated for every live target (pre-render, no repaint
   until a session uses it). **Model removed** → its assets are pruned after `pruneGraceMs` once no target has
   them applied or in flight (standalone RC2 rule kept).
3. **Target added** (group created / joined) → its base and marks generated, then painted. **Target removed**
   (left / deleted / not found) → its assets and assignment record removed.
4. **Turn off** → writer stops; nothing repainted back; `/badge purge` removes the cache and state on request.
5. Required-set fingerprint covers available model ids, badge rules, target ids, generator params and
   RENDERER_VERSION; a change triggers an incremental rebuild (generate missing, prune unused), never a full wipe.

## 4. Channel-agnostic core

1. Core never imports a provider. Providers implement the standalone `BadgeProvider` interface (list targets,
   resolve session key → target, apply asset, classify errors, asset size, capabilities).
2. Provider registry in the extension; `provider` config picks one or more (`providers: ["signal"]`), each with
   its own account/config block and its own applied/status namespace.
3. **Signal provider** uses freeclaw's own Signal client/transport for the configured **account** (resolve the
   daemon by account, never by position or a written-down port), and must work over both HTTP and the unix-socket
   transport.
4. Session → target mapping uses freeclaw's session-key parsing, not string surgery on the key.

## 5. Integration with freeclaw

1. Extension layout like `extensions/swarm`: `openclaw.plugin.json` (config schema + uiHints), `index.ts`
   (registerService for the writer, event hooks, commands), `src/core/*`, `src/providers/signal/*`.
2. Triggers (closed model, standalone O3): session model change, models-available change, target create/remove,
   startup and periodic reconcile. Subscribe through the plugin API events; fall back to the store watcher only
   where no event exists. Document which.
3. Commands: `/badge status|repaint [target]|audit|purge`, operator-gated (config `operators`, matched on the
   authenticated sender id).
4. Rasteriser: `rsvg-convert` if present, else `magick`; missing both → health `renderer-missing`, writer idle,
   no crash. Real-render tests skip only with an explicit "renderer unavailable" reason, and CI notes it.
5. State: `<stateDir>/plugins/model-badge/` (applied.json, status.json, writer.lease, assets/). Cache dir must be
   readable by the provider's daemon (Signal attaches by path).

## 6. Tests

(Also the §2a.7 steering and §2b.8 image-generation tests.)

Port the standalone behaviour suite (reconciler, pacing, rate-limit/captcha, parking, lease/takeover, incident
replays, property tests) to vitest with synthetic fixtures; plus:

1. Generator determinism (same target → same base bytes hash; different targets differ; same model → same mark).
2. Mark derivation: rules match; fallback letters unique within an available set; contrast choice.
3. Lifecycle: model add → generated, no repaint; model remove → pruned after grace; target add → generated +
   painted; target remove → assets + record gone; turn-off → no writes.
4. **No committed art gate:** repo contains no `.svg/.png/.jpg/.webp` under the extension and no embedded
   base64 images or SVG path data longer than the parametric primitives.
5. Provider-agnostic core: a fake second provider passes the same core suite.
6. Hygiene: no names, hosts, IPs, phone numbers, real ids, home paths.

## 7. Out of scope (v1)

Deploy and live checks (operator, on the test agent first), non-Signal providers' implementations (interface +
fake only), migration from the old hook's state (fresh start is fine: first reconcile repaints once, paced).

## 8. Hygiene

Org identity, no trailers. Nobody pushes.
