# Config reload

Status: design (operator). Dated sections, newest last. No other design file covers config reload; user-facing
behaviour is in `docs/gateway/configuration.md` ("Config hot reload"). Code: `src/gateway/config-reload.ts`,
`src/gateway/config-reload-plan.ts`, `src/gateway/server-reload-handlers.ts`, `src/gateway/server.impl.ts`.

## 2026-11-12 Reload baseline must be comparable with the reload snapshot (spurious channel restarts)

### Symptom

On testclaw (11 Nov 2026, 11:07 AWST) a hot reload logged `[gateway/channels] restarting signal channel`; signal-cli
got SIGTERM and came back on a fresh random port (messages in flight can drop). The logged change list held twelve
`models.providers.<id>.apiKey` paths. On the flux gateway the same happened to `msteams` five times (10 and 11 Nov), with
`channels.msteams.appPassword` as the only channel path in the list.

### Cause (two parts, verified on `integ/v32` 4e0e395b0b)

1. **Baseline mismatch (the bug).** `src/gateway/server.impl.ts` seeds `startGatewayConfigReloader({ initialConfig })`
   with `cfgAtStart`, which by then is the _resolved_ config (after `activateRuntimeSecrets`: every SecretRef object such as
   `{ source: "file", provider: "cbkey", id: "value" }` replaced by its secret string). The reloader's `readSnapshot`
   (`readConfigFileSnapshot`) returns the _unresolved_ config (SecretRef objects). `diffConfigPaths(currentConfig, nextConfig)`
   therefore reports every SecretRef-typed field as changed on the **first** reload after each gateway start, whatever the
   edit was: all `models.providers.*.apiKey`, `channels.msteams.appPassword`, other `channels.*` tokens. Any of those under
   `channels.<id>` matches the channel's `reload.configPrefixes` and adds `restart-channel:<id>` to the plan. Later
   reloads compare snapshot with snapshot and are not affected, which is why it only shows once per start.
   `models.providers.*` alone maps to `restartHeartbeat` only (no channel); that part of the planner is correct.
2. **Planner granularity (by design, not changed here).** Any `channels.signal.*` path, including
   `channels.signal.groups.<groupId>`, restarts the Signal channel, and the Signal monitor takes its config once at start
   (`monitorSignalProvider({ config: ctx.cfg })`), so a real change to Signal's own config needs the restart. The 11:07
   reload really did contain `channels.signal.groups.<id>` (a group was added), so that restart was legitimate;
   the apiKey paths were noise. Restarting the channel without killing signal-cli is a separate follow-up.

### Rule

A hot reload restarts a channel only when a path under that channel's own `reload.configPrefixes` changed in the config
**as written to the file**. Changes to `models.*`, other channels, or to secret _values_ behind an unchanged SecretRef
never restart a channel.

### Fix

- The reloader's baseline and every later snapshot must be the same kind of config. Preferred: the baseline is the
  unresolved source config (the `sourceConfig` of the startup secrets snapshot, or an initial `readSnapshot()` taken when the
  reloader starts), not `cfgAtStart`. `onHotReload` keeps receiving the resolved config for activation, as today.
  Startup writes that persist to the file (generated `gateway.auth.token`, seeded `gateway.controlUi.allowedOrigins`) must
  be in the baseline too, so they do not show up as a change either.
- Secret _rotation_ behind an unchanged SecretRef is out of scope here (still handled by `secrets.reload`).
- No change to `buildGatewayReloadPlan` prefixes, to `diffConfigPaths`, or to the Signal channel.

### Tests (the first one fails on 4e0e395b0b and is written and committed before the fix)

1. `src/gateway/config-reload.test.ts`, reloader level: `initialConfig` holds resolved strings for
   `channels.msteams.appPassword` and `models.providers.x.apiKey`; `readSnapshot` returns the same fields as SecretRef
   objects; after one reload `onHotReload` is called with `restartChannels` empty, and `changedPaths` has no SecretRef-only entry.
   (A throwaway version of this test was run on 4e0e395b0b: `restartChannels` = `["msteams"]`.)
2. `src/gateway/server.reload.test.ts`: with a SecretRef `models.providers.openai.apiKey` (see `writeEnvRefConfig`), the
   `initialConfig` passed to `startGatewayConfigReloader` contains the SecretRef object, not the resolved string.
3. Planner guard in `config-reload.test.ts`: `["models.providers.x.apiKey"]` gives an empty `restartChannels` and
   `restartHeartbeat` true; with a signal plugin registered, `["channels.signal.groups.g="]` still restarts signal and
   `["channels.msteams.appPassword"]` does not.
4. A real change still reloads: after the baseline fix, editing `channels.signal.allowFrom` restarts signal and
   nothing else; editing one `models.providers.x.apiKey` SecretRef id restarts no channel.
5. Existing `config-reload.test.ts` and `server.reload.test.ts` suites stay green.

### Other channels

The planner is generic, so every channel with a SecretRef field under `channels.<id>.*` was hit the same way
(seen live: `msteams`, `signal`). The baseline fix covers all of them; the tests use `msteams` and `signal` as the
two representatives. Channels without SecretRef fields were never affected by this part.

### Live acceptance (operator, on testclaw only)

`config.patch` that changes only a `models.providers.<id>.apiKey` value leaves no `restarting <channel> channel` line in
the gateway log and signal-cli keeps its pid; a Signal message still gets a reply.
