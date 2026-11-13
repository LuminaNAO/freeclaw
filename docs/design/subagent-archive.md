# Sub-agent archive must never kill a live run (2026-11-13)

## Defect (found 12-13 Nov 2026, production)

`src/agents/subagent-registry.ts`: for `spawnMode: "run"`, `registerSubagentRun` and the steer/restart path set
`archiveAtMs = now + archiveAfterMs` (default `agents.defaults.subagents.archiveAfterMinutes` = 60) at SPAWN time.
`sweepSubagentRuns()` (every 60 s) deletes every entry whose `archiveAtMs` has passed, calling `sessions.delete` with
`deleteTranscript: true`, WITHOUT checking whether the run has ended. Any run-mode sub-agent still working after 60 min
is killed mid-turn: its session and transcript are deleted, the run aborts ("Request was aborted"), and the parent
gets no completion event. Evidence: run 76ce32f6, spawned 21:05:59, `sessions.delete` at 22:05:59 while the child was
mid tool call; `agent.wait 3599877ms` returned at the same moment. `runTimeoutSeconds: 0` (no limit) did not help:
archive is a separate clock.

## Rule

Archiving is cleanup of FINISHED runs. It must never end a live run, and the run limit is the only thing that may.

1. `archiveAtMs` is set when a run ENDS (`endedAt + archiveAfterMs`), never at spawn. A run that has not ended has no
   `archiveAtMs`. This applies to the spawn path, the steer/restart path and records restored from disk (a restored
   record with no `endedAt` keeps none; a legacy record with a spawn-time `archiveAtMs` and no `endedAt` has it
   cleared on restore).
2. The sweeper skips any entry without `endedAt`, whatever its `archiveAtMs` (defence in depth), and logs once per run
   when it skips a stale `archiveAtMs` on a live run.
3. DEFERRED (operator, 13 Nov: out of scope, existing kill/stop behaviour unchanged). A run that ends by being killed for any reason other than its own completion (abort, timeout, gateway restart,
   delete) ALWAYS produces a completion event for the parent with the reason, so a parent never waits on a silent
   child. Include the last assistant text if any.
4. `runTimeoutSeconds` stays the only limit on run length (0 or unset = no limit, as today). The parent's `agent.wait`
   for completion uses that limit; with no limit it waits until the run ends (re-arming the wait if a transport cap
   applies) instead of treating a wait timeout as the end of the run.
5. Tests: a run-mode child that runs past `archiveAfterMinutes` (fake clock) is not deleted, finishes, announces, and
   is archived `archiveAfterMinutes` after it ended; restored legacy record with spawn-time archiveAtMs and no
   endedAt is not swept; a killed child announces with reason; `runTimeoutSeconds: 0` child runs past 60 min; existing
   archive behaviour for finished runs unchanged.
