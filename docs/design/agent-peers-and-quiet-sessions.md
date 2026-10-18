# Agent peers and quiet sessions — ARCH

Owned by the operator; engineers do not edit it. Each commit names the section it implements.

## 1. Problem (operator, 2026-10-18)

Two agents in one group, both answering without a mention, looped: one agent's error notice was answered by the
other, which errored and posted its own notice, ~17 messages in a minute. Both fixes below are **manual operator
settings**. With nothing set, behaviour is exactly as today.

## 2. Marking an identity as an agent (trust graph)

1. The Signal trust store (`src/signal/trust/store.ts`) gains an optional per-identity flag `agent: true`. Set and
   cleared only by an operator: CLI `openclaw signal trust mark-agent <uuid>` / `unmark-agent <uuid>`, and the same
   as a gateway method. Never inferred.
2. When the sender of an inbound group message is marked `agent`, that message triggers a turn **only if it
   mentions this agent** (Signal mention of our account, or our name per the existing mention patterns). Otherwise
   it is recorded in group history as today and no turn runs. DMs from a marked agent are unchanged.
3. No identity marked → no change anywhere (the check is a no-op).
4. `openclaw signal trust status` lists marked agents.

## 2a. Agentic (operator, 2026-10-18 10:38)

Everything in §2 and §3 is also an agent tool action, so an operator can just ask the agent ("mark X as an agent"):
the agent `gateway` tool gains `signal.trust.markAgent`, `signal.trust.unmarkAgent` (uuid) and `sessions.setQuiet`
(sessionKey, errorReplies?, slashCommands?), calling the same gateway methods as the CLI. Allowed only when the
current turn's sender is an operator (senderIsOwner); otherwise refused. Tests: operator turn can do each; non-operator
refused; CLI unchanged.

## 3. Quiet session settings

1. Two optional per-session settings, set only by an operator (CLI `openclaw sessions set <key> --no-error-replies
--no-slash-commands`, a gateway method, and the operator-only `/session` command):
   - `errorReplies: false` — a failed turn posts nothing to the chat (no "⚠️ …" notice, no provider error text). The
     error is still logged and visible in `openclaw status`.
   - `slashCommands: false` — inbound text starting with `/` is treated as ordinary text in that session (no
     command parsing), except an operator's `/session` command so the setting can be undone.
2. Unset → exactly today's behaviour. Stored on the session entry like other overrides; survives restart.
3. `openclaw sessions show <key>` shows both settings.

## 4. Tests

- Marked agent, no mention → no turn, history recorded; with mention → turn runs; unmarked → unchanged; nothing
  marked → byte-identical behaviour to base.
- mark/unmark via CLI and method, operator-only.
- `errorReplies: false` → failing turn sends nothing to the channel; unset → notice as today.
- `slashCommands: false` → `/status` arrives as text; operator `/session …` still works; unset → commands as today.
