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
4. **Escape hatch:** an operator's `/focus` command is always handled, in any session, even while focused away.

## 4. Commands and tool

- `/focus <session-key | here>` sets the target (`here` = the session the command is sent from). `/focus off` ends
  it. `/focus` with no argument shows target, since, and the per-session waiting count (`gateway stack`).
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
- `/focus` from an operator works in a non-target session while focused; a non-operator is refused.
- Off: three waiting prompts in one session → exactly one turn whose prompt contains all three in order with sender
  and time; all three files deleted after; route is the newest message's.
- Restart while focused: focus still on after start; non-target files not replayed until off.
- No focus set: behaviour byte-identical to today (existing stack tests unchanged).
