# Heartbeat session compaction — ARCH

Owned by the operator; engineers do not edit it. Each commit names the section it implements.

## 1. Problem (operator, 2026-10-18)

The heartbeat session only grows (scheduled turns, never a person running /compact). One agent runs a daily
script + cron that checks its size and sends /compact through chat.send. That works but is a per-agent workaround.
It becomes built-in, default-on behaviour.

## 2. Rule

1. **Where.** `src/infra/heartbeat-runner.ts`, `runHeartbeatOnce`: before a heartbeat turn starts, read the
   heartbeat session's context size. If it is above the threshold (§3), run the same compaction `/compact` runs
   (`compactEmbeddedPiSession`, `trigger: "heartbeat"`, memory flush included), then run the heartbeat turn on the
   compacted session.
2. **Model (operator, amended 2026-11-21).** Compaction always runs on the session's own model: the model a
   normal message to that session would run on (the session's stored model override, or its parent's; else the
   channel model override; else the agent default). `heartbeat.model` is a per-turn choice for the heartbeat turn
   and is **never** used to pick the compaction model, and neither is any other per-turn or per-job model. The
   threshold window `W` (§3) and the compaction thinking level come from that same model. Never switch model for
   compaction: it breaks the cache, changes summary quality, and replays one model's transcript to another.
   - This holds for every session the heartbeat runner can be pointed at, including a scheduled wake that targets
     a chat session by key, not only the default heartbeat session.
   - One resolver, shared by the compaction, the threshold and `openclaw status`.
   - Scope (operator, 2026-11-21, kept small on purpose): this section changes the heartbeat pre-turn compaction
     only. Left exactly as they are:
     - `/compact` runs on the session's model. `agents.defaults.compaction.model` stays what it is today: an
       explicit operator opt-in that replaces the model for `/compact` and for compaction inside a running turn.
       It never applies to the heartbeat pre-turn compaction.
     - Compaction inside a running turn (overflow, prune) keeps the running turn's model. Known and accepted: a
       turn that runs on another model than its session and overflows mid-turn compacts on the turn's model.
       The pre-turn compaction keeps the session under the threshold, so this is rare. No change in `run.ts`.
   - Bug this replaces: the first build let `heartbeat.model` win over the session's override, so a session
     running on model A was compacted by model B whenever a scheduled wake landed on it.
3. **Only when idle.** Skip and retry at the next heartbeat if a run is active on that session or the gateway is
   draining. Never interrupt a turn.
4. **Instructions.** Optional `heartbeat.compactInstructions` passed as compaction custom instructions.
5. **Quiet.** One log line per compaction (before → after tokens). Nothing is sent to any chat. `openclaw status`
   shows the heartbeat session's size, threshold and last compaction time.
6. **Default on**, for new installs and upgrades. `heartbeat.compactAt: off` disables.
7. **Nothing to compact (operator, 2026-11-24).** Observed on a live gateway: the heartbeat session reported
   126k to 130k tokens against a 100k threshold. Every pre-turn compaction was cancelled by the compaction safeguard
   ("no real conversation messages to summarize"), logged as "compaction failed (will retry next heartbeat)", and
   tried again on every heartbeat for about 18 hours, each time after a memory flush turn. Numbers at the time: the
   last good compaction left a summary of about 23k characters and kept about 127k characters of recent messages.
   - A compaction that ends with nothing to summarize (the safeguard cancel, or `compacted: false` for that reason)
     is an outcome, not a failure. Log it once at info level with the token count. Real errors keep the existing
     rule (log, retry next heartbeat).
   - Record on the session entry the token count at which it happened. Make no new attempt (no memory flush, no
     compaction) until the session has grown past that count by at least 20 % of the threshold. A successful
     compaction by any path (`/compact`, in-run) clears the record.
   - Find out why the size test is over the threshold when nothing can be compacted (what the counted tokens are
     made of: system prompt, tools, kept tail, summary) and state it in the DONE report with numbers. If the size
     the test uses includes parts compaction can never reduce, report BLOCKED with the numbers and a one-line
     proposal. Do not change the threshold maths (section 3) on your own.

## 3. Threshold (operator's rule)

Let `W` = the max context window of the model the heartbeat session uses.

- Default threshold: `min(100_000, 0.5 × W)` — 100k, unless 100k is more than half the window.
- An explicit `heartbeat.compactAt` (tokens) is allowed but clamped to `min(150_000, 0.5 × W)`.
- So the heartbeat session never exceeds 150k and never takes more than 50 % of the window.
  Examples: 1M → 100k; 200k → 100k; 128k → 64k.

## 4. Tests

- 1M model → 100k; 200k → 100k; 128k → 64k; explicit 140k on 1M → 140k; explicit 200k → clamped to 150k;
  explicit 140k on 200k → clamped to 100k.
- Over threshold → one compaction on the session's own model, then the heartbeat turn on the compacted session.
- Model (§2.2): session override A + `heartbeat.model` B → compaction, threshold and status all use A. No session
  override, channel override C, `heartbeat.model` B → C. No overrides, agent default D, `heartbeat.model` B → D.
  Parent session override is inherited. An override that is not in the model allowlist falls through to the next
  step, never to `heartbeat.model`. A wake that forces another session key compacts that session on its own model.
  The heartbeat turn itself still runs on `heartbeat.model` (unchanged by this section).
- Under threshold, `off`, active run, or draining → none.
- Compaction failure → heartbeat turn still runs, error logged, retried next time.
- Memory flush runs as part of it.
- Nothing to compact (§2.7): over threshold, safeguard cancels → logged once at info, not as a failure; the next
  heartbeat at the same size makes no attempt and runs no memory flush; after growth of 20 % of the threshold past
  the recorded count, one new attempt; a successful `/compact` clears the record; a real error still retries next
  heartbeat.
