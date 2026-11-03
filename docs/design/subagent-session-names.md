# Subagent session names — ARCH (operator, 2026-11-02)

Problem: subagent sessions show in every session list (TUI, Control UI, sessions_list, tokentail) as
`subagent/<uuid>`. Nobody can tell what a 900k-token session was for. The spawn already takes a `label`, but it is
only kept in the run registry, never written to the session entry, and the registry entry goes when the run ends.
Applies the house standard: one ops core (the spawn path writes the session entry); every frontend only reads it.

1. **Name at spawn.** The child session entry gets `label` and `displayName` at spawn, in the same patch that writes
   `spawnedBy`:
   - `label` = the spawn's `label` if given; else a short slug made from the task's first line (lowercase words,
     max 6 words / 40 chars, no ids, paths or URLs).
   - `displayName` = `<requester short name> › <label>`, where the requester short name is the requester session's
     own displayName/subject (e.g. a group name), trimmed to 24 chars; nested subagents chain once
     (`<parent label> › <label>`).
2. **Kept after the run.** The name lives on the session entry, so it survives the run registry entry, gateway
   restarts and transcript archiving. Never overwritten by later patches unless the operator renames it.
3. **Shown everywhere from the entry.** Session list views (TUI, Control UI, `sessions_list`, `openclaw sessions`)
   already prefer `displayName`; no frontend change beyond that. The `subagent/<uuid>` form stays as the key.
4. **Tool hint.** The `sessions_spawn` tool description tells the model to always pass a short `label`.
5. Tests: label given → entry has label + displayName; no label → slug from task; nested spawn chains; name survives
   run end + restart; sessions_list shows the displayName; slug never contains a path, URL or uuid.
