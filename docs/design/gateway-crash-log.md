# Gateway crash log + memory evidence (ARCH)

Owned by the operator; engineers do not edit it. Every commit names the section it implements. A real conflict with
the code is `BLOCKED`, not resolved in code.

## 0. Incident (why)

Production gateway (systemd user unit, `NODE_OPTIONS=--max-old-space-size=16384`) died after ~48 h:
`FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory`, last mark-compacts
16.29 GB → 16.24 GB (nothing reclaimable: a real leak, not a spike). systemd restarted it silently. Nobody was told;
the only evidence was the journal and a 2 GB core file. Same process sat at ~2.1–2.6 GB RSS 20 minutes after start.
Two needs: (a) every crash is recorded and announced; (b) enough memory evidence to find the leak.

## 1. Crash log

1. On start the gateway checks whether the previous run ended uncleanly: a run marker
   `<stateDir>/run/gateway.json` `{ pid, startedAt, version }` is written at start and removed on clean shutdown
   (stop/restart path). If present at start → previous run crashed.
2. On crash detection append one JSON line to `<stateDir>/logs/crashes.jsonl`:
   `{ detectedAt, pid, startedAt, uptimeMs, version, reason, lastHeap }` where `reason` comes from the last
   process-exit record (§1.3) if any, else `"unknown (no exit record)"`, and `lastHeap` from §2's last sample.
3. Exit record: on `uncaughtException`, `unhandledRejection` (if it terminates), fatal signals that node can catch,
   and V8 near-heap-limit (`v8.setHeapSnapshotNearHeapLimit` is not required; use
   `--heapsnapshot-near-heap-limit` only if §3 enables it) write `<stateDir>/run/last-exit.json` synchronously
   `{ at, pid, kind, message, stack (first 40 lines) }`. A hard OOM abort may write nothing — then §1.2 says
   unknown and §2's samples carry the evidence.
4. Announce: after channels start, if a crash was detected, enqueue one system event to the main session
   (`Gateway restarted after crash: <reason>, uptime <h>h, heap <GB> at last sample`) so the agent tells its
   humans. No new channel code.
5. `openclaw gateway crashes [--json] [--limit N]` prints the log (reads the file; works with gateway down).

## 2. Memory sampling

Every 60 s append to `<stateDir>/logs/memory.jsonl`:
`{ at, pid, uptimeMs, rss, heapUsed, heapTotal, external, arrayBuffers, sessionsLoaded, activeRuns, queueDepth }`
(last three from existing in-process state if cheaply available; omit fields you cannot get without new
tracking). Rotate: keep the file under 20 MB (truncate oldest half). No config flag; constants in code.

## 3. Heap evidence for leak hunting

1. `openclaw gateway heap-snapshot` — asks the running gateway (existing gateway RPC, operator scope) to write
   `v8.writeHeapSnapshot()` into `<stateDir>/logs/heap-<ts>.heapsnapshot` and print the path. Warn that it pauses
   the process for seconds and the file is large.
2. When heapUsed crosses 75 % of the heap limit (`v8.getHeapStatistics().heap_size_limit`) the gateway writes ONE
   automatic snapshot per process lifetime and logs it. This is the evidence the next OOM would otherwise destroy.

## 4. Find the leak (investigation, report not code-first)

Using a throwaway gateway on loopback with its own state dir (never the production gateway), reproduce growth:
load a large existing transcript set (copy, read-only source given in the task), drive turns via gateway `agent` /
`chat.send` for a sustained period, take heap snapshots at intervals with §3.1, and diff retainers. Candidates
to check first (unverified): session transcripts held in memory across sessions (prod session files reach
16–46 MB each), delivery-mirror / chat.history caches, followup queue maps (`FOLLOWUP_QUEUES`,
`RECENT_QUEUE_MESSAGE_IDS`), per-run listeners not removed, the stack ownership WeakMap holders, debug logging
(`DEBUG=agents:*` is set on prod). Deliver `docs/design/gateway-oom-findings.md`-style findings in the
BUILD_DONE emit (path in the worktree, not in this ARCH): top retainers with sizes, the growth curve, the root
cause with evidence, and a proposed fix. Implement the fix only if it is small and the evidence is conclusive;
otherwise stop at the report.

## 5. Acceptance

1. Unit: marker written/removed; crash detected on unclean start; crashes.jsonl line shape; last-exit read; memory
   sampler rotates; announce enqueued once.
2. Live, throwaway gateway: SIGKILL → next start logs a crash with `reason: unknown (no exit record)` and the system
   event is enqueued; clean `gateway stop` → next start logs nothing; `gateway crashes` shows the entry;
   `gateway heap-snapshot` writes a file.
3. §4 report delivered with evidence.
4. Full suite: no new failures vs `origin/supermaster`.
