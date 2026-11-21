# Per-session context limit — ARCH (operator, 2026-11-21)

## 0. Why

Models with a 1M window let a chat grow very large before it compacts. Some chats (a small alerts group) work
better and cheaper with a lower ceiling. Today the only cap is `agents.defaults.contextTokens`, for the whole agent.
The operator wants to lower the ceiling for chosen chats only. **Default behaviour does not change:** with nothing
set, everything resolves exactly as before.

## 1. The setting

1. One optional number on the session entry: `contextLimit` (tokens). It belongs to the chat (session key), not to a
   transcript: it survives `/new`, `/reset`, compaction, model switches and restarts. Absent = no limit of our own.
2. Effective window = the lowest of: the model's window (as resolved today), `agents.defaults.contextTokens` (as
   today), and `contextLimit`. It can only lower, never raise. One resolver computes it; every consumer uses that
   resolver: the run's model window (so auto-compaction triggers on it), the compaction paths, context-window
   guard, `/status`, `/context`, the recorded `contextTokens` of the session, and session listings.
3. Bounds: an integer at or above `CONTEXT_WINDOW_HARD_MIN_TOKENS`; below it is refused with the minimum named.
   Accepted forms in commands: plain tokens, `k` and `m` suffixes (`256k`, `0.5m`).
4. Not inherited: sub-agent, cron and swarm sessions have their own keys and are unaffected.

## 2. Ways to set it (same effect, same validation)

1. Chat command `/context limit <n>|default` in the chat it applies to. Authority: owner/operator senders only
   (same gate as other session-changing commands); others get a one-line refusal. `/context limit` alone shows the
   current value and the effective window with its source.
2. Gateway method `sessions.patch` accepts `contextLimit: number | null` (null clears).
3. Agent tool `session_status` accepts optional `contextLimit` (number, or `"default"` to clear) for the current
   session or a `sessionKey`, beside its existing model override, so an operator can ask the agent in plain words.
   The tool applies it only in a turn whose sender is an owner/operator; otherwise it refuses.

## 3. Behaviour

1. Takes effect on the next turn, no restart. If the chat is already above the new limit, the next turn compacts
   first through the existing overflow/auto-compaction path; nothing is dropped without a compaction summary.
2. `/status` shows the effective window and, when our limit is the lowest, marks it (e.g. `Context 33k/256k (limit;
model 1.0m)`).
3. Clearing returns the chat to today's resolution on the next turn.

## 4. Tests

Absent → every existing resolution test unchanged (no behaviour change); limit below model window lowers the run's
model window and the compaction threshold; limit above the model window or above `agents.defaults.contextTokens`
has no effect (lowest wins); below the hard minimum refused by command, patch and tool alike; `k`/`m` parsing;
survives `/new`, `/reset`, compaction and a model switch; cleared by `default`/null; non-operator sender refused by
command and by tool; a chat above the new limit compacts on the next turn; `/status` and session listing show the
effective value and source; sub-agent of a limited chat is not limited; command, patch and tool give the same result.
