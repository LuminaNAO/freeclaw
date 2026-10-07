# Swarm orchestration — ARCH

Source of truth for `extensions/swarm`. This document is owned by the operator; engineers do not edit it.
Development is architecture-driven: there is no separate spec. Code and README follow this file; each commit
names the ARCH section it implements. A conflict is a defect: stop and raise it (`BLOCKED`), do not resolve
it in code.

## 1. Principles
1. **Swarm, not hierarchy.** Modules click together. Each one MUST either push forward, return backward, or
   report upstream. Nobody polls and there is no central router service.
2. **Everything is a session in one gateway**: taskmasters and workers. Workers are the same agent (same
   identity) in different sessions.
3. **Session = mailbox.** One run at a time per session. Messages that arrive mid-run queue up (`collect`) and
   arrive together as the next turn. Parallelism = more sessions.
4. **Normal flow vs exceptions.** Routing drives the normal flow. API errors, quota, gateway restarts and silent
   workers are exceptions with their own layer (§7). Deadlines only catch silence; they never drive flow.
5. **Visibility = session switching**, plus an optional channel group per taskmaster. Nothing about who the
   operator is, or which channel exists, is hard-coded.
6. **Durable by file.** All task state lives on disk, so any task resumes after a gateway restart.
7. **Channels are optional.** With no channel configured (or the channel unavailable) a task runs exactly the
   same; the operator follows it by switching sessions or via `swarm list/show`. A missing channel never
   blocks or fails a task.
8. **Generic and reusable.** No person, agent, phone number, group id, host or org path anywhere. Upstream
   targets, models, thinking levels and repos come from the task contract or plugin config.

## 2. Roles
| Role | What it is | Channel group | Lifetime |
|---|---|---|---|
| Upstream | whoever started the task: a session key and/or a channel target, from contract/config | n/a | permanent |
| Taskmaster | owns one task, drives workers, reports upstream | optional, disposable | until done |
| Worker | builder / auditor / tester / researcher / any role | none (session only) | per task |
| Child task | a taskmaster started by a taskmaster (e.g. an auth task mid-build) — post-MVP | optional | until done |

## 3. Task contract (`<stateDir>/swarm/<task-id>/contract.yaml`)
```yaml
id: <task-id>
kind: build                 # template
input: <brief / path / ask>
done_when: <checkable condition>
workers:
  build: { count: 1, model: <provider/model>, thinking: off }
  audit: { count: 1, model: <provider/model>, thinking: high }
  test:  { count: 1, model: <provider/model>, thinking: off }
routes: <§5 table, or the template default>
upstream: { sessionKey: <optional>, channel: <optional>, events: [DONE, BLOCKED, FAILED] }
budget: { wall: 4h, step_silence: 30m }
repo: <path to the working checkout>
```
- `model` and `thinking` per role are **applied to the worker session** (not just mentioned in its brief).
  A worker must never silently run on a different model than its contract says.
- `count` > 1 and `join` are reserved for §6 and rejected in the MVP.

## 4. Messages (the only coupling)
Every handoff is a gateway agent message to the target session, with a header:
```
TASK <id> | FROM <role> | TO <role|taskmaster|upstream>
EVENT <BUILD_DONE|AUDIT_PASS|AUDIT_FAIL|TEST_PASS|TEST_FAIL|BLOCKED|DONE|...> @ <sha>
<body: findings / evidence / ask>
```
- **The sha is information, not a gate.** An event carries the sha the sender is talking about; it is logged
  and passed on as-is. Nothing is refused for its sha. `swarm show` reports the repo head.
- **Every emit is routed.** There is no duplicate rule: a worker may emit BLOCKED and later BUILD_DONE for the
  same input, and both route. The session lane already allows one run at a time per session.
- **Logged.** Every send is appended to `events.jsonl`: the audit trail, the board feed and the resume source.
- **Urgent** messages (stop, ARCH changed) interrupt the run (`steer`); everything else queues (`collect`).
- Task wake-ups are always agent messages to the task's own sessions — never main-session system events
  (those run on the heartbeat model, not the worker's model).

## 5. Routing (default build template; data, not code; per-task override)
| On | From | Push / return |
|---|---|---|
| BUILD_DONE @X | build | → audit "review X" |
| AUDIT_FAIL @X | audit | ← build, findings |
| AUDIT_PASS @X | audit | → test "test X" |
| TEST_FAIL @X | test | ← build, repro + failing test |
| TEST_PASS @X | test | → taskmaster "gate passed X" |
| gate passed | taskmaster | merge → DONE upstream |
| BLOCKED | anyone | → taskmaster, then upstream if a human is needed |

An example, not final: each template ships its own table, and a task may override it.

**Exit enforcement.** A worker run that ends without emitting a routed event is invalid. The taskmaster is told
"worker X ended without exit", re-prompts it once, then escalates upstream.

**One run per session, no races.** A re-prompt is an ordinary message to the worker's session: it queues
behind any run still active there. The swarm never starts a second run in a session, never aborts a run to
re-prompt, and never re-prompts a session that has an active run.

**Operator answers.** `openclaw swarm answer <task> <message>` logs an `OPERATOR` event and delivers the
message to the taskmaster. It is the only operator side channel; interventions are always in `events.jsonl`.

## 6. Fan-out / join (designed now, built after the MVP)
- **Fan-out** = one event to N worker sessions:
  - auditors by redundancy (same sha, different models, so blind spots differ);
  - testers by dimension (functional, adversarial, platform);
  - builders by partition (one worktree/branch each; the join is an integrator that merges).
- **Join** = a module (a taskmaster role, or its own session) that must push or return:
  - `all` (default for gates): every result green on the same sha;
  - `quorum-k`: k passes proceed; dissent must be answered (build replies to each dissenting finding, the
    dissenter re-checks);
  - `any`: first success wins, the rest are cancelled;
  - the join deduplicates findings, so build gets one list instead of N.
- **Width** is set in the contract; the taskmaster may widen it per policy (e.g. security-tagged → 3 auditors).

## 7. Exceptions (separate from the normal flow)
| Exception | Detect | Handle |
|---|---|---|
| Worker silent | a run ended without an emit (exit enforcement, §5); a long run is never "silent" | §5 |
| Run error / provider down | run ends in error | retry once → upstream FAILED (fallback model post-MVP) |
| Quota exhausted | 403/429 quota text | upstream BLOCKED with reason (remap post-MVP); never wait silently |
| Gateway restart | sessions persist | resume (§8), resend undelivered messages |
| Taskmaster dies / loses context | no upstream event past `budget.wall` | escalate; post-MVP respawn from contract + events |

There is no step-silence watchdog. `budget.step_silence` is accepted in old contracts and ignored.

## 8. Resume
- State = `contract.yaml` + `events.jsonl` + `outbox.jsonl` (sent, not yet acknowledged).
- After a gateway restart, for each open task:
  1. resend unacknowledged outbox entries (idempotent, never double-delivered);
  2. for each session (workers and taskmaster) whose last delivered input has no emit after it and that has
     no active run: deliver that same input again, with one line on top: `[gateway restarted during this
     input; check what is already done, then finish and emit]`.
- That is the whole rule. It holds on every restart, however many in a row: there is no "already re-prompted"
  skip and no counter. A task that keeps crashing the gateway is stopped by the operator (`swarm cancel`).
- When the gateway's own session prompt stack lands, step 2 is deleted: the stack replays the unfinished
  prompt itself. Until then step 2 is the swarm's resume.
- Acceptance includes killing the gateway mid-task, twice in a row on the same input; it finishes with no
  human action.

## 9. MVP scope
- One worker per role, linear routes (§5), default build template + per-task override.
- Contract, event log, outbox, emit path, routing, exit enforcement, resume, upstream delivery,
  start/list/show/cancel/answer with `--json` on reads, channel-less operation.
- Reserved and rejected for now: fan-out/join (§6), child tasks, model remap, channel group creation
  (interface + no-group mode only).

## 10. Acceptance (MVP)
1. A dummy build task runs build → audit → test → DONE with zero operator messages after start; upstream
   receives DONE.
2. An injected defect bounces back to build and the flow re-runs to DONE.
3. A worker that stops without emitting is re-prompted by the taskmaster.
4. Killing the gateway mid-task, then restarting, finishes the task with no human action; killing it twice in
   a row on the same input does too.
5. All of the above with no channel configured, and each worker verifiably ran on its contract model.
6. A worker that emits BLOCKED and later BUILD_DONE for the same input has both routed.
7. An event whose sha differs from the last one is routed, not refused.
8. A long-running worker turn (longer than any old step_silence) raises no alarm.
9. `swarm answer` reaches the taskmaster and appears in `events.jsonl` as `OPERATOR`.

## 11. Later
Fan-out/join (§6); child tasks with a depth limit; a reserved concurrency lane for interactive sessions;
per-role thinking defaults from R&D; a board generated from `events.jsonl`.
