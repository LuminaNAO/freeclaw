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
2. **Model.** The compaction runs on the model the heartbeat session is already using (its override, else the
   heartbeat model, else the agent default — whatever the turn itself would use). Never switch model for
   compaction: it would break the cache and change quality.
3. **Only when idle.** Skip and retry at the next heartbeat if a run is active on that session or the gateway is
   draining. Never interrupt a turn.
4. **Instructions.** Optional `heartbeat.compactInstructions` passed as compaction custom instructions.
5. **Quiet.** One log line per compaction (before → after tokens). Nothing is sent to any chat. `openclaw status`
   shows the heartbeat session's size, threshold and last compaction time.
6. **Default on**, for new installs and upgrades. `heartbeat.compactAt: off` disables.

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
- Under threshold, `off`, active run, or draining → none.
- Compaction failure → heartbeat turn still runs, error logged, retried next time.
- Memory flush runs as part of it.
