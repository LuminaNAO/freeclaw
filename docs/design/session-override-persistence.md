# Session override persistence — ARCH v1

Status: operator-owned. Engineers never edit it; commits name the section.

## 1. Problem (observed)

On the gateway `agent` path (`src/commands/agent.ts`: CLI `agent`, isolated cron turns, `sessions_send`), a session
model override written **during** a turn is lost at the end of that turn. Reproduced: the `session_status` tool with
`model=<alias>` wrote `modelOverride`/`providerOverride` to the session store; ~1.3 s later the end-of-run store
update (`updateSessionStoreAfterAgentRun`, `src/commands/agent/session-store.ts`) wrote the entry back without them and
with the run's model as the runtime model. The next turn runs on the default model while the status card had already
reported the override. The channel reply path (`src/auto-reply/reply/session-usage.ts`) patches only run fields and is
not affected.

Cause: the end-of-run update starts from the **turn-start in-memory snapshot** (`sessionStore[sessionKey]`) and merges
it over the on-disk entry, so any field another writer changed during the turn (override fields set by tools,
commands or `sessions.patch`) is clobbered by its stale value. Explicit `undefined` own keys in the snapshot (e.g. the
gateway handler's `modelOverride: entry?.modelOverride`) make it worse.

## 2. Rule

1. End-of-run (and any other post-run) session-store writes on the agent path are **patches of run-owned fields
   only**: `sessionId`, `updatedAt`, runtime `model`/`modelProvider`, `contextTokens`, token/cache counters,
   `totalTokens*`, `compactionCount`, `abortedLastRun`, `systemPromptReport`, CLI session ids. Computed against the
   entry **re-read inside the store lock**, never from the turn-start snapshot.
2. User-/tool-owned fields are never written by the end-of-run update: `modelOverride`, `providerOverride`,
   `authProfileOverride*`, `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `fastMode`, `sendPolicy`, labels,
   delivery fields. Whatever is on disk at end of run stays.
3. If an override is present on disk at end of run and differs from the model the run used, the runtime
   `model`/`modelProvider` fields are **not** set to the run model (they are cleared, as
   `applyModelOverrideToSessionEntry` does), so status surfaces show the selected model and the next turn resolves
   it.
4. No explicit-`undefined` own keys in patches that go through `mergeSessionEntry` (they overwrite). Omit the key.
5. Same rule for the other `persistSessionEntry` call sites in `agent.ts` that run after the turn starts: patch, don't
   rewrite from a snapshot.

## 3. Tests (regression)

1. Tool sets an override mid-turn (simulate `session_status` model change during the run) → after the run the store
   still has `modelOverride`/`providerOverride` → the **next** turn's resolved provider/model is the override.
2. Override set via `sessions.patch` while a turn is running → survives end of run.
3. Reset (`model=default`) mid-turn → override cleared and stays cleared.
4. Usage/token fields still update at end of run (no regression), runtime model = run model when no override.
5. Channel reply path behaviour unchanged (existing tests green).

## 4. Hygiene

No real names, hosts, IPs, home paths in code, tests or docs. Org identity, no trailers.
