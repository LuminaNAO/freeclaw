# Session prompt stack — fix: no stale replay (ARCH addendum)

Owned by the operator; engineers do not edit it. Amends `docs/design/durable-inbox.md` (v2). Every commit names the
section here it implements. A real conflict with the code is `BLOCKED`, not resolved in code.

## 0. Incident (why)

Production gateway crashed (heap OOM) after ~48 h up. On start, `session stack: replaying 2 session(s)` re-ran a
direct inbound prompt that had been **answered 48 h earlier**: it arrived while the session was busy, was queued
in `collect` mode, consumed by a collect turn ("[Queued messages while agent was busy]"), the reply was delivered —
and its stack file was never deleted. The user received a fresh reply to a 2-day-old message. Every restart can
replay any such leaked file. Leak candidates seen by reading the code (prove which, do not guess):

- `dispatch-from-config.ts` binds files to `ctx`; `dispatch.ts` passes `finalizeInboundContext(ctx)` onward. If any
  layer copies the context (`{...ctx}`) the binding (WeakMap keyed by object identity) is lost and no turn owns
  the file. Identity-keyed ownership is fragile by construction.
- `agent-runner.ts` enqueue path: `takeStackFiles` empties the shared array, then rebinds a `.slice()` copy; the
  outer `finally { finishStackFiles(stackFiles) }` in dispatch now holds an emptied array. Correct only if the
  queued item is later consumed through `runConsuming`; any path that consumes or discards queue items without
  `runConsuming` / `clearFollowupQueue` (collect batches, cross-channel individual drain, summary drain, queue
  replacement, session reset, queue object recreated by `getFollowupQueue`) leaks.
- Steer path deletes only when `waitForEmbeddedPiRunEnd` resolves true; a process exit first leaks (acceptable by
  §1 of v2 — that is a genuine unfinished prompt), but a run that ends without signalling would also leak.

## 1. Fix A — find and close the leak

1. Write a failing test first that reproduces the incident: session busy, inbound prompt arrives, is queued
   (`collect`), consumed by the collect turn, reply delivered → **no stack file remains**. Also for `followup`,
   `steer`, `steer-backlog`, `interrupt`, queue cap drop, `/stop`, `/new`/reset, cross-channel collect, summarize.
2. Fix every leaking path found. Prefer making ownership robust over patching each path: the turn-end rule must
   not depend on object identity surviving every copy (e.g. carry the file paths as a plain field on the context /
   followup run that survives spreading, or key ownership by message id). Keep v2 rules: plain files, no DB, no
   counters, no flags.

## 2. Fix B — replay never re-runs a prompt already in the transcript

Belt and braces for any leak not found. Before replaying an `inbound` file, if its payload carries a message id
(`MessageSidFull` ?? `MessageSid`) and that id already appears in that session's transcript as a user turn, the
prompt was consumed: delete the file, log `session stack: dropped stale <session> <file> (already in transcript)`,
do not dispatch. For `agent` files use the idempotency key the same way if the transcript records it; if it does
not, leave `agent` replay unchanged (do not invent a record). No new state: the transcript is the record.

## 3. Fix C — age guard

A stack file older than `24 h` at startup is not replayed: delete it and log
`session stack: dropped expired <session> <file> age=<h>h`. Constant in code, no config flag. (A gateway down >24 h
replaying day-old prompts is worse than dropping them; the human re-asks.)

## 4. Observability

- `session stack: replaying N session(s)` also logs per file: session, file, age, source, first 60 chars.
- `openclaw gateway stack` unchanged.

## 5. Acceptance

1. Unit: every path in §1.1 leaves no file after its turn ends; the incident repro test fails on the old code and
   passes on the new.
2. Unit: §2 stale drop (id in transcript → dropped, not dispatched); id absent → replayed byte-identical (v2 §2.1).
3. Unit: §3 expired drop.
4. Live, throwaway gateway (loopback, own state dir, no channels): v2 §10.2 a–e still pass; plus **f.** prompt sent
   while busy, collected, answered, then SIGTERM restart → nothing replayed, `gateway stack` empty.
5. Full suite: no new failures vs `origin/supermaster` (pre-existing failures listed, proven on a clean worktree).
