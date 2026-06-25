# `signal-group-memory.sh` — agent handoff

**Purpose:** refresh Signal identity dump + sync onto per-group memory dirs. Idempotent, non-destructive. **Stop the openclaw gateway first** — signal-cli account is single-locked.

**Run:**

```bash
./signal-group-memory.sh <workspace>              # refresh + sync (default)
./signal-group-memory.sh <workspace> --dry-run    # preview only
./signal-group-memory.sh <workspace> --no-refresh # use existing current.json
./signal-group-memory.sh <workspace> --dump <p>   # custom dump (no refresh)
```

Refresh chain: `signal-identity-diff.sh` → `signal-identity-dump.sh` → `signal-identity-dumps/current.json`.
Exit `0` ok · `1` runtime/refresh fail · `2` bad args.

## Output

```
<workspace>/group-memory/signal/
  index.json                         "group:<id>" → {path, name, status}
  <internal-dirname>/                opaque to agents — never compare
    meta.json
    members.json
    history.md
```

## Lookup recipe

Index keys are the **harness-canonical chat_id** — `"group:<raw-base64-id>"`, exactly the string the agent receives in the inbound system metadata block (`schema: openclaw.inbound_meta.v1`, field `chat_id`). Zero transformation.

```js
// pseudocode
const entry = index[ctx.chat_id]; // verbatim lookup
const dir = path.join(workspace, entry.path);
const meta = JSON.parse(read(`${dir}/meta.json`));
```

The agent never reads or constructs `<internal-dirname>`. It is filesystem-internal.

## `meta.json`

Script-managed (refreshed every run, others preserved):
`signal_id` (= `"group:<id>"`), `name`, `description`, `group_invite_link`,
`message_expiration_seconds`, `blocked`, `member_count`, `status`,
`agent_active`, `first_seen_at`, `last_seen_at`, `left_at`.

`status` ∈ `active` (we're in) · `left` (kicked/left, still tracked) · `removed` (gone from dump).

Agent-managed: anything else — `purpose`, `agent_role`, `notes`, `channel_etiquette`, … — preserved across runs.

## `members.json`

Shape: `{members: {<uuid>: {...}}}`.

Script-managed: `uuid, number, isAdmin, status, first_seen_at, last_seen_at, left_at`.
`status` ∈ `active` · `pending` · `requesting` · `left` · `banned`.

Agent-managed: `name` (null until set, then sticky) + any custom keys.

## `history.md`

Empty stub on creation, never overwritten. Narrative layer.

## Guarantees

- Re-run safe; same dump twice = only `last_seen_at` ticks.
- Member departs → `status="left"`, `left_at` set; entry kept.
- Member returns → `status="active"`, `left_at` cleared.
- Group rename → `meta.name` overwrites; index/path unchanged (anchored on id).
- Atomic writes (no half-files visible).
- Anything outside the script-managed key list survives every run.

## Agent workflow

1. Run script (refresh is automatic).
2. On each inbound message in a group, take `chat_id` from system meta and look it up in `index.json`.
3. Open `<workspace>/<entry.path>/{meta.json,members.json,history.md}` to ground the reply.
4. Learn a name from chat → set `members.<uuid>.name`. Permanent.
5. Memorable event → append to `history.md`.
6. Don't delete entries; status fields handle absence.

## Failure modes

- `refresh failed` → openclaw gateway is up, OR signal-cli broken. Stop gateway and retry, or `--no-refresh`.
- `status="removed"` for a group you're in → signal-cli's local cache is stale. `signal-cli -a <num> receive`, then re-run.
- `jq required` → `pacman -S jq`.
