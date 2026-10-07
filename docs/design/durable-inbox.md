# Session prompt stack — ARCH (v2, minimal)

Source of truth for the session prompt stack in the gateway. Owned by the operator; engineers do not edit it.
Architecture-driven: no separate spec; each commit names the section it implements. A real conflict with the
code is raised as `BLOCKED`, not resolved in code. v2 replaces v1 completely (v1 = SQLite inbox; dropped).

## 1. What it is

A buffer. A prompt that reaches a session is kept on disk until the turn that consumed it ends. If the gateway
stops first (restart, crash, kill), the prompt is handed to the session again on the next start. Nothing else.

## 2. Rules

1. **Pass-through.** The stored prompt is exactly what ingress received, including who sent it and where it
   came from (channel, account, sender id, route, thread, attachments, idempotency key), and it is replayed
   unchanged: no marker, no rewrite, nothing derived. Trust, owner status and tools are the session's business,
   decided from that same data exactly as today. The stack adds no trust logic.
2. **Minimal.** Plain files. No database, no new dependency, no states, no counters, no config flag, no plugin
   API. Fewer moving parts beats coverage of edge cases.
3. **Behaviour unchanged** when nothing restarts: same queueing, same dedupe, same replies.

## 3. Store

- `<stateDir>/stack/<encoded session key>/<arrival ms>-<n>.json`, one file per prompt. Directory mode 0700,
  files 0600 (same sensitivity as transcripts).
- File = `{ "source": "inbound" | "agent", "payload": <what that ingress received, as received> }`.
- Written (temp file + rename) before the prompt is queued or run.
- Deleted when the turn that consumed it ends, whatever the outcome (reply, error, abort, `/stop`). A turn
  that consumed several prompts (collect, summarize, steer into an active run) deletes all of them when it ends.
  A prompt dropped by queue policy is deleted when dropped.
- **A file on disk means unfinished.** That is the whole state.

## 4. Ingress points

Two, both existing:

- `inbound` — inbound dispatch, after the existing duplicate check (channels and `chat.send` both enter here).
- `agent` — the gateway `agent` method (CLI, TUI, subagent runs and announces all use it).
  Nothing is stored anywhere else. Heartbeat and cron turns are not stored (they fire again on schedule).

## 5. Startup replay

After channels start, before new ingress: for each session directory with files, re-submit them oldest first
through the same ingress point they came from, unchanged. The session then does exactly what it would do if
those prompts had just arrived (queue, collect, run). Each replayed file is deleted by the normal rule (§3)
when its turn ends. Replies route as the original would (the route is in the payload).

## 6. Restart drain

While draining for restart, ingress writes the file and returns accepted without starting a run (instead of
`GatewayDrainingError`). The next start replays it.

## 7. Commands

- `openclaw gateway stack` — per session: number of files, oldest age, first 80 characters of the oldest
  prompt. Reads the files directly, so it works with the gateway up or down.
- `openclaw gateway stack drop` — the kill switch: stop the gateway exactly as `openclaw gateway stop` does,
  delete every stack file, leave the gateway stopped, print how many were dropped per session. The next start
  replays nothing. Asks for confirmation unless `--yes`.

## 8. Known trade-off (accepted)

A prompt that crashes the gateway will crash it again on every start. The way out is `gateway stack drop`.

## 9. Build order

1. Store + write at both ingress points + delete at turn end (§3, §4).
2. Startup replay (§5).
3. Drain (§6).
4. Commands (§7).

## 10. Acceptance

1. Unit: file written before the run; deleted on reply, error and abort; a collected turn deletes all it
   consumed; replay order oldest first; the replayed payload is byte-identical to the stored one.
2. Live, throwaway gateway with no channels, ingress via gateway `agent` and `chat.send`:
   a. A running, B and C queued, SIGTERM restart: after start A, B, C run in order, each once more, with the
   same sender and route; `gateway stack` shows them before and nothing after.
   b. Same with SIGKILL mid-A.
   c. A prompt sent during the drain window is accepted and runs after the restart.
   d. A prompt whose turn finished before the restart is never replayed.
   e. `gateway stack drop --yes` with queued prompts: gateway stops, files gone, the next start replays nothing.
3. Full gateway test suite green; no new dependency.
