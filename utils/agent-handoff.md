# Signal helpers — agent handoff

You have three scripts. Together they give you a refreshable, per-group
memory layer over Signal.

## What's here

- `signal-identity-dump.sh` — emits a JSON snapshot of self / contacts /
  groups to stdout. Read-only. **Don't run while the openclaw gateway
  is up** — it holds the signal-cli account lock and you'll just hang.
- `signal-identity-diff.sh` — wraps the dump: writes `current.json` and
  `current.diff`, archives the previous run as `<TS>.json` / `<TS>.diff`.
  Use this instead of calling the dumper directly when you want history.
- `signal-group-memory.sh <workspace>` — projects `current.json` onto
  per-group memory dirs inside the openclaw workspace. Idempotent and
  non-destructive: it never deletes a group, never deletes a member,
  and never overwrites fields it doesn't manage.

Default dump location: `signal-identity-dumps/current.json` next to the
scripts. Override with `--dump <path>` on the diff/memory scripts.

## Suggested loop

1. `./signal-identity-diff.sh` — refresh state.
2. `./signal-group-memory.sh <workspace>` — sync the memory layer.
3. Read `<workspace>/group-memory/signal/index.json` to see what landed.
4. For groups you care about, read their `meta.json` + `members.json` +
   `history.md`.
5. **Enrich**: fill in member `name` as you observe people in chats;
   append narrative to `history.md`; add custom keys to `meta.json` for
   group-specific knowledge.

## Looking up a group

Group IDs in openclaw.json (`channels.signal.groups`) are 44-char base64
strings with `/`, `+`, `=`, e.g.
`0Qc/wHffzC8y4BJB9qB2dOdKw0xqfmdv7wutKT8lDo4=`.

The simplest path:

1. Open `<workspace>/group-memory/signal/index.json`.
2. The signal_id is a literal key — read it as-is, no transformation.
3. Index entry gives you `{dirname, name, status}`.
4. Open `<workspace>/group-memory/signal/<dirname>/meta.json` etc.

If you need to map by hand, the dirname rule is exactly: replace `/`
with `_`. `+` and `=` stay. So you can also reach the dir directly
without the index — but the index is faster and avoids the transform.

## File contents

### `index.json`

```
{ "<signal_id>": { "dirname": "...", "name": "...", "status": "active|left|removed" } }
```

Rebuilt every run from the on-disk meta.json files (single source of
truth). If you add a custom field to a meta.json, it stays in meta.json
but isn't surfaced in the index — that's fine.

### `meta.json` (per group)

Script-managed fields, refreshed every run:

| field                                      | type           | notes                                                                           |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------------------- |
| `signal_id`                                | string         | raw 44-char base64 (with `/`)                                                   |
| `dirname`                                  | string         | the on-disk folder name                                                         |
| `name`, `description`                      | string \| null | overwritten on rename — log change history yourself in `history.md` if you care |
| `group_invite_link`                        | string \| null |                                                                                 |
| `message_expiration_seconds`               | int            | group-wide disappearing-message timer                                           |
| `blocked`                                  | bool \| null   |                                                                                 |
| `member_count`                             | int            | from the dump, may lag reality slightly                                         |
| `status`                                   | enum           | `active` / `left` / `removed` (see below)                                       |
| `agent_active`                             | bool           | true ⇔ status="active"                                                          |
| `first_seen_at`, `last_seen_at`, `left_at` | ISO timestamps |                                                                                 |

Status semantics:

- `active` — we're a current member.
- `left` — signal-cli still tracks the group, but we're not a member
  (we left or were kicked). `agent_active=false`.
- `removed` — the group disappeared from the dump entirely. The
  directory and history are preserved.

**You can add any other fields.** They survive across runs untouched.
Conventional ones to consider: `purpose`, `agent_role`, `notes`,
`channel_etiquette`, `safety_notes`.

### `members.json` (per group)

```
{ "members": { "<uuid>": { ... } } }
```

Keyed by Signal UUID. Per-member script-managed fields:

| field                                      | type           | notes                                                            |
| ------------------------------------------ | -------------- | ---------------------------------------------------------------- |
| `uuid`                                     | string         |                                                                  |
| `number`                                   | string \| null | E.164; often null because Signal doesn't share numbers with bots |
| `isAdmin`                                  | bool           |                                                                  |
| `status`                                   | enum           | `active` / `pending` / `requesting` / `left` / `banned`          |
| `first_seen_at`, `last_seen_at`, `left_at` | ISO timestamps |                                                                  |

Agent-managed:

- `name` — `null` until you set it. **Once non-null, the script never
  touches it again.** Fill these in as you see people speak — most won't
  have a name from signal-cli because the bot doesn't have DMs with them.
- Any other custom fields per member (e.g., `role`, `vibe`, `aliases`)
  are preserved across runs.

### `history.md` (per group)

Created empty by the script if missing. **Never overwritten.** This is
the narrative layer — write up group events, norms, member backstory,
running threads, anything that doesn't fit a structured field.

## Behaviour you can rely on

- **Member departure**: status flips to `left`, `left_at` set. Entry is
  kept. If they come back, status flips to `active`; the old `left_at`
  stays as a record of the last departure.
- **Group rename**: `meta.name` is overwritten silently. The dirname
  doesn't change (it's anchored on the master key, not the name).
- **Group disappearance**: status → `removed`, dir kept untouched.
- **Group revival**: status → `active`, agent_active true. Old
  `left_at` preserved.
- **Idempotent**: running twice in a row with the same dump only ticks
  `last_seen_at` timestamps.
- **Atomic writes**: every write goes through tempfile + rename; a
  half-written file is never visible to a concurrent reader.

## Failure modes

- **Diff script fails with timeout** → almost certainly openclaw is up
  on this host (any user). The script prints a hint listing the
  matching processes. Stop the gateway and retry.
- **`signal-group-memory.sh` says a group you're in is "removed"** →
  the dump doesn't contain it. Re-run `signal-identity-diff.sh` first.
- **Empty groups list in current.json** → signal-cli ran but listGroups
  returned nothing. Account is registered but might not be a member of
  any group, or signal-cli sync state is broken — try
  `signal-cli -a <number> receive` to nudge it.

## Schema

The dump shape is documented in `signal-identity.schema.json`
(JSON Schema 2020-12). Useful when you want to validate a dump before
reading it.

## CLI cheatsheet

```bash
# Refresh dump (writes current.json + current.diff)
./signal-identity-diff.sh

# Sync a workspace
./signal-group-memory.sh /path/to/workspace
./signal-group-memory.sh /path/to/workspace --dry-run

# Group-engagement policy (channels.signal.groupPolicy)
./signal-group-toggle.sh --policy open       # engage in every group
./signal-group-toggle.sh --policy disabled   # ignore all groups
./signal-group-toggle.sh                     # interactive per-group menu
```
