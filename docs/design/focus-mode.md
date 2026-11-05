# Focus mode — ARCH

Owned by the operator; engineers do not edit it. Each commit names the section it implements. A real conflict with
the code is `BLOCKED`, not resolved in code.

## 1. What it is (operator, 2026-10-17)

An operator can put the agent into focus on one session. While focused, inbound messages for every other session are
kept on disk but not processed. Only the target session runs. When focus ends, each session that has waiting
messages gets them as one combined prompt. It reuses the session prompt stack (docs/design/durable-inbox.md); it adds
one state flag and one gate.

## 2. State

- One gateway-wide value: `{ target: <session key>, since, by }`, or none. Stored in `<stateDir>/focus.json`
  (0600, temp file + rename), so it survives restarts. No timeout, no timer: focus lasts until cleared.
- The target may be any session key (group, DM, main, console, cron run is refused as a target: it is not
  addressable by a person).

## 3. The gate

At inbound dispatch, at the same point as the restart-drain check (stack §6), after the stack file is written:

1. No focus, or the message's session key equals the target → unchanged.
2. Otherwise → the file stays on disk, the turn is not started (same as drain), and the sender gets one short
   reply: "Busy right now, I'll reply later." Sent at most once per session per focus period, so a burst of messages
   gets one notice. Silent-reply surfaces are respected (the notice is a normal reply).
3. **Not gated:** cron and heartbeat turns (not stored, stack §4) and the gateway `agent` ingress used by
   subagents, announces and the swarm. Focus is about people's inbound messages only.
4. **Escape hatch:** an operator's `/focusmode` command is always handled, in any session, even while focused away.

## 4. Commands and tool

- `/focusmode <session-key | here>` sets the target (`here` = the session the command is sent from). `/focusmode off`
  ends it. `/focusmode` with no argument shows target, since, and the per-session waiting count (`gateway stack`).
  (Operator decision 2026-10-17: the chat command is `/focusmode`. The existing `/focus` and `/unfocus` are the
  Discord/Telegram thread-binding commands and stay exactly as they are.)
- Same actions on the CLI (`openclaw gateway focus [set <key>|off|status]`) and as a gateway method, so the agent can
  do it with its tools when asked by an operator. Operator authority only (the existing owner/command-authorization
  check); anyone else gets the standard refusal.

## 5. Ending focus

1. `off` clears the state first, so new messages flow normally from that instant.
2. Then, per session with waiting stack files, oldest session first: the files are combined into ONE prompt and
   replayed through the normal inbound path. The combined prompt is the messages in arrival order, each prefixed by
   its sender and time, under one line: "These messages arrived while I was busy (oldest first):". The route,
   account and reply target are the newest message's. Attachments of all of them are kept.
3. When that one turn ends, all of the session's original files are deleted (stack §3 rule for a turn that consumed
   several prompts).
4. A gateway restart during focus keeps focus on (state is on disk). Startup replay (stack §5) skips files of
   non-target sessions while focused, and replays them combined when focus ends.

## 6. Tests

- Focused: target session runs; another session's message is stored, not run, and gets one busy notice; a second
  message to it gets no second notice; cron and `agent`-ingress turns run normally.
- `/focusmode` from an operator works in a non-target session while focused; a non-operator is refused.
- The existing `/focus` and `/unfocus` thread-binding commands are unchanged (their tests stay green).
- Off: three waiting prompts in one session → exactly one turn whose prompt contains all three in order with sender
  and time; all three files deleted after; route is the newest message's.
- Restart while focused: focus still on after start; non-target files not replayed until off.
- No focus set: behaviour byte-identical to today (existing stack tests unchanged).

## 7. Focus v2: many sessions, tiers, one name (operator, 2026-11-05)

Replaces the single target of §2 and the command names of §4. §3 (the gate's place), §5 (the combined replay) and
the stack mechanics stay as they are.

### 7.1 State: focus is an attribute of a session
- Each session may carry a **focus tier**: `none` (the default) < `normal` < `hyper`. Tiers are an ordered list in
  code (`FOCUS_TIERS`), so more can be added later without changing the rule.
- `<stateDir>/focus.json` becomes `{ sessions: { <session key>: { tier, since, by } } }`. Same file rules as §2
  (0600, temp file + rename, survives restarts, no timers). A v1 file `{ target, since, by }` is read as
  `{ sessions: { <target>: { tier: "normal", since, by } } }` and rewritten in the new form the next time it is saved.
- Cron runs still cannot be a target (§2).

### 7.2 The rule
- **Active level** = the highest tier any session holds. If no session holds a tier above `none`, the active level is
  `none`.
- At the §3 gate, a person's inbound message for session S **runs iff tier(S) ≥ active level**. Otherwise it is
  buffered exactly as in §3: the file stays, the turn does not start, one busy notice per session per focus period.
- So: no focus anywhere means everything is open, byte-identical to today. Focusing several sessions at `normal` means
  all of them run and everything else waits. Adding one `hyper` session means only the hyper sessions run, and the
  `normal` ones wait too, until the hyper focus is removed.
- Not gated, as §3.3: cron, heartbeat, and the gateway `agent` ingress (subagents, announces, swarm). The operator's
  `/focus` command always runs (§3.4).

### 7.3 Lowering focus releases what is now allowed
Whenever the active level drops, or a session's tier rises to meet it, every session that is now allowed and has
waiting files gets the §5 combined replay (oldest session first, one combined prompt each, files deleted after the
turn). Clearing the last focus replays all waiting sessions. A restart keeps the state, and startup replay (§5.4) only
replays sessions that are allowed at the current level.

### 7.4 One name: `/focus`
- **Remove** the Discord/Telegram thread-binding commands `/focus` and `/unfocus`, and the `/subagents focus|unfocus`
  actions. Remove their docs, help text and tests. The session-binding service itself stays, because
  `sessions_spawn` with `thread: true` (ACP and subagent thread sessions) still uses it. Only the commands go.
- `/focusmode` is renamed `/focus`. `/focusmode` stays as a hidden alias for one release, and prints the new name.
- Commands (operator only, §4 authority):
  - `/focus` shows each focused session with its tier and since, the active level, and the waiting count per session.
  - `/focus here [normal|hyper]` and `/focus <session key> [normal|hyper]` set a tier (default `normal`).
  - `/focus off here` and `/focus off <session key>` set that session back to `none`.
  - `/focus off` (alone) clears all focus.
- The same ops on the CLI (`openclaw gateway focus [status|set <key> [--tier t]|off [<key>|--all]] [--json]`) and as a
  gateway method the agent can call when an operator asks. One ops function behind all three (house rule: CLI, chat
  and tool call the same function).

### 7.5 The agent knows how focus works
- A short **Focus** section goes into the system prompt of every new session: what focus is, the tiers, the rule in
  §7.2, the commands, and that only an operator can set it. Five lines at most. It is also added when the session has
  focus state: the current active level and whether this session is focused.
- The compaction instructions keep that section, so it survives compaction (the same mechanism that keeps other
  standing rules, `compaction-instructions.ts`).

### 7.6 Tests
- v1 file loads as one `normal` session; v2 round-trips.
- No focus: existing inbound tests unchanged (byte-identical).
- Two `normal` sessions: both run, a third waits with one notice. Add `hyper` on a fourth: only the fourth runs, the
  two `normal` ones now wait. Remove `hyper`: the two `normal` ones get their combined replay, and the third still
  waits. `/focus off`: the third replays.
- Restart while focused at mixed tiers: the state holds, and startup replays only allowed sessions.
- `/focus` from an operator works in a waiting session; a non-operator is refused; `/focusmode` still works and names
  `/focus`.
- The thread-binding `/focus` and `/unfocus` and `/subagents focus|unfocus` are gone (registry, docs, help); a
  `sessions_spawn` thread binding still works (its tests stay green).
- The system prompt contains the Focus section (size-capped). Compaction keeps it.
- CLI, chat and gateway-method parity with `--json`.
