# Gateway process discovery under a process title — ARCH

Source of truth for finding a running gateway process on Linux. Owned by the operator; engineers do not edit
it. Architecture-driven: no separate spec; each commit names the section it implements. A real conflict is raised
as `BLOCKED`.

## 1. Problem

The gateway sets `process.title` to `openclaw-gateway` (`src/cli/program/preaction.ts`). On Linux that overwrites
`/proc/<pid>/cmdline`, which then reads exactly `openclaw-gateway` (plus NUL padding): no script path, no
`gateway` argument. `isGatewayArgv` (`src/infra/gateway-process-argv.ts`) requires a `gateway` argument and an
entry path, or an executable path ending in `/openclaw-gateway`, so a titled gateway is never recognised.
Consequences: `openclaw gateway stop` cannot find a gateway that is not managed by a service unit, and
`openclaw gateway stack drop` (which stops the gateway first) cannot stop it.

## 2. Rule

1. A process whose parsed cmdline is exactly the single token `openclaw-gateway` (the process title) is
   recognised as a gateway wherever the gateway-binary form is accepted today (`allowGatewayBinary`).
2. Discovery must still pick **the right gateway**: when several gateways run as the same user (different state
   dirs / ports), `gateway stop` and `stack drop` stop only the one whose port matches the configured
   `gateway.port` of the invoking config (port ownership via the listening socket), never another one. If the
   port owner cannot be determined, refuse with a clear message rather than guessing.
3. Nothing else changes: service-managed gateways keep stopping through their service unit; Windows/macOS paths
   are untouched.
4. Minimal: no new dependency, no new config.

## 3. Acceptance

1. Unit: `isGatewayArgv(["openclaw-gateway"], {allowGatewayBinary:true})` is true; the existing positive/negative
   cases are unchanged; a process titled anything else is not matched.
2. Unit: with two titled gateway processes on different ports, discovery for a config on port A returns only
   the pid listening on A.
3. Live, throwaway gateway started by hand (not a service) from this checkout on port 40797, state dir
   a throwaway state dir: `openclaw gateway stop` stops it; a second throwaway gateway on 40798 with
   its own state dir keeps running; then `openclaw gateway stack drop --yes` against a fresh 40797 gateway stops
   it and clears the stack. Other gateways on this host (40790-40796) untouched.
4. Full test suite: no new failures versus clean origin/supermaster; `pnpm build` green.
