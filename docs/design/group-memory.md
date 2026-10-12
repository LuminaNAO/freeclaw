# Group memory — ARCH

Owned by the operator; engineers do not edit it. Each commit names the section it implements. A real conflict with the
code is `BLOCKED`, not resolved in code.

## 0. Why

An agent in many chat groups needs per-group memory: what the group is for, who is in it, what was decided, the
current state. Today that only exists as one operator's private workspace convention (`group-memory/<channel>/<id>/`
written by the agent because its AGENTS.md says so). A fresh freeclaw agent has nothing: it starts every group
session cold, and a group compaction or `/new` loses the group's purpose. Group memory must work out of the box,
for every channel, with no setup.

## 1. Layout (workspace, plain files)

`<workspace>/group-memory/<channel>/<url-encoded group id>/`

- `meta.json` — `{ channel, groupId, name, description?, members: [ids], firstSeen, lastSeen, contextFile? }`.
  Maintained by the gateway (§3), never by the model.
- `CONTEXT.md` — durable context: purpose, people and roles, scope boundaries, decisions, current state, open
  items. Written by the agent (§4). Size target ≤ 4 KB; the agent keeps it current, not a log.
- `history.md` — append-only dated one-liners of notable events and decisions. Written by the agent.
- Directory 0700, files 0600 (same sensitivity as transcripts). Encoding = `encodeURIComponent(groupId)`.

## 2. Load into group sessions

For every group session (any channel whose session key is a group: `agent:<a>:<channel>:group:<id>`), the system
prompt gains a `## Group memory` block with: the group name and member count from `meta.json`, the full
`CONTEXT.md` (if present), and the last 20 lines of `history.md` (if present), plus one line naming the folder path.
Missing files are simply absent; a new group shows "No group memory yet — create CONTEXT.md when the group's
purpose is clear." The block is built per turn from the files (cheap reads, no cache beyond the existing
bootstrap-file cache), so edits are picked up on the next turn and survive compaction and `/new`.
Group memory is NEVER loaded into another group's session or into a DM/main session (isolation: a group only ever
sees its own folder).

## 3. Gateway-maintained meta

On each inbound group message the gateway updates `meta.json`: create on first sight (name from the channel's group
subject when known), `lastSeen`, and add new sender ids to `members`. Throttled to at most one write per group per
minute. Channel adapters already expose the group id and subject in the inbound context; no adapter changes beyond
passing what they have.

## 4. Agent writing

- The default workspace template (`docs/reference/templates/AGENTS.md`) gains three lines under Group Chats: in a
  group, your memory for it is `group-memory/<channel>/<id>/` (path shown in the Group memory block); keep
  `CONTEXT.md` current with decisions and state; append notable events to `history.md`; never copy another group's
  or private memory into it.
- No new tool: the agent uses its normal file tools on that path. The path is inside the workspace, so existing
  sandbox/workspace rules apply unchanged.

## 5. Config

`agents.defaults.groupMemory: { enabled: boolean (default true), historyLines: number (default 20), maxContextBytes:
number (default 16384, larger CONTEXT.md is truncated in the prompt with a note) }`. Per-agent override under
`agents.list[].groupMemory`. Disabling stops loading and meta writes; files stay.

## 6. Compatibility

Existing folders in the §1 layout (an operator who already uses this convention) are read as-is; unknown keys in an
existing `meta.json` are preserved on update; an existing `context_file` key pointing elsewhere in the workspace is
honoured as the context file instead of `CONTEXT.md`.

## 7. Tests

- Group session gets the block with CONTEXT + last N history lines; DM/main session never does; group A never sees
  group B's files.
- meta.json created on first message, members/lastSeen updated, throttled, unknown keys preserved.
- Block survives compaction and `/new` (it is rebuilt from files).
- Truncation at maxContextBytes; disabled flag stops both loading and writes.
- `context_file` override honoured.
- Template lines present.
