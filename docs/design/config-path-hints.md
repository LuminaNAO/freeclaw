# Config path hints — ARCH v1

Status: operator-owned. Engineers never edit it; commits name the section.

## 1. Problem

`config.schema.lookup`, `openclaw config get|set|unset` answer a wrong or partial path with a bare
"path not found". Callers (humans and agents) read that as "the setting does not exist" — when the
setting exists under a parent (e.g. `instanceName` is really `gateway.instanceName`).

## 2. Behaviour

1. On not-found, search the whole schema (core + plugins) for keys whose **last segment** equals the
   requested last segment (case-insensitive), then close matches (edit distance <= 2 on the last
   segment, or the full path). Return up to 5 full paths, exact-leaf matches first.
2. The error text says what happened precisely: `no config path "<p>"` — never "does not exist" —
   and, when suggestions exist, `did you mean: gateway.instanceName`.
3. `config.schema.lookup` keeps `ok:false` + `INVALID_REQUEST`; suggestions go in
   `error.details.suggestions: string[]` and are appended to the message.
4. CLI `config get|set|unset` print the same suggestions. `config set` on an unknown path still
   refuses (schema validation unchanged).
5. Deterministic order; no network; cost bounded (schema walk once per call is fine).

## 3. Tests

Leaf hit under a parent (`instanceName` → `gateway.instanceName`), typo (`gateway.instancName`),
case (`gateway.instancename`), no match (no suggestions, message unchanged apart from wording),
plugin-schema key suggested, CLI output, gateway RPC details field.

## 4. Hygiene

No real names, hosts, IPs, home paths in code, tests or docs. Org identity, no trailers.
