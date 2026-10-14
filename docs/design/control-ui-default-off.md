# Control UI off by default — ARCH

Operator decision, 2026-10-14. The web Control UI is not used on any of our deployments. Serving it costs memory
and adds an HTTP surface. It becomes opt-in.

## 1. Rule

1. `gateway.controlUi.enabled` defaults to **false** when unset. Every place that reads it with a `?? true`
   fallback changes to `?? false`: gateway runtime config, `status`, `status --all`, daemon status print, onboarding
   finalize. One shared helper (`isControlUiEnabled(cfg)`) replaces the scattered fallbacks so they cannot drift.
2. When disabled the gateway serves no Control UI assets and no Control UI routes (existing `controlUiEnabled=false`
   behaviour); WebSocket clients (CLI, nodes, apps) are unaffected.
3. Fresh installs and onboarding write nothing for the UI (default off). Onboarding does not offer or print a
   dashboard URL when it is off; it prints how to enable it (`openclaw config set gateway.controlUi.enabled true`).
4. Status output shows `Control UI: off` (not an error) when disabled.
5. Existing configs that set `enabled: true` keep it. Configs that omit it change to off on upgrade: the release
   note says so in one line.

## 2. Tests

- Unset config → runtime config has controlUiEnabled false; an HTTP GET for the UI root returns 404.
- `enabled: true` → UI served as before.
- Status and onboarding output for both states.
- No remaining `controlUi?.enabled ?? true` in non-test source (source-scan test).
