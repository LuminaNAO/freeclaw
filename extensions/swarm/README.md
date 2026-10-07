# Swarm (plugin)

Runs one task as a set of sessions in a single gateway that hand work to each other by routed
messages: build, audit, test, plus a taskmaster that reports upstream. There is no polling loop
and no external orchestrator. Task state lives on disk, so an open task resumes after a gateway
restart.

- [`ARCH.md`](./ARCH.md): the design, owned by the operator. Source of truth. There is no
  separate spec: code and this README follow ARCH, and each commit names the ARCH section it
  implements.

No messaging channel is needed. Follow a task by switching into its sessions or with
`openclaw swarm list` / `openclaw swarm show`.

## Enable

```json
{
  "plugins": {
    "entries": {
      "swarm": { "enabled": true }
    }
  }
}
```

Optional plugin config (all fields optional; contract values win):

```json
{
  "plugins": {
    "entries": {
      "swarm": {
        "enabled": true,
        "config": {
          "defaultModel": "provider/model",
          "defaultThinking": "off",
          "lane": "subagent",
          "upstream": { "sessionKey": "agent:main:main" },
          "budget": { "wall": "4h" }
        }
      }
    }
  }
}
```

## Task contract

```yaml
id: add-greeting
kind: build
input: Add a greet(name) function and a unit test to the scratch repo.
done_when: the unit test passes on the head commit
repo: /path/to/working/checkout
workers:
  build: { model: provider/model, thinking: "off" }
  audit: { model: provider/model, thinking: high }
  test: { model: provider/model, thinking: "off" }
upstream:
  sessionKey: agent:main:main
  events: [DONE, BLOCKED, FAILED]
budget: { wall: 4h }
```

`budget.step_silence` from older contracts is accepted and ignored: there is no step-silence
deadline.

Each worker's `model` and `thinking` are applied to its session before the first message. If the
gateway refuses one, the task is not started. `count` must be 1 and `join` is rejected: fan-out
and join are reserved for later. `routes` may replace the default build table.

## Commands

```bash
openclaw swarm start --file task.yaml      # validate, apply models, brief build, kick taskmaster
openclaw swarm list [--json]               # tasks with status, sha, recent event, age
openclaw swarm show <task-id> [--json]     # models per role, event log, handover timeline
openclaw swarm cancel <task-id> [--reason] # stop every task session, close the task
openclaw swarm answer <task-id> <message>  # answer the taskmaster; logged as OPERATOR
```

- `start --file` resolves a relative path against the directory you run the command from (or
  the package-manager launch directory, `INIT_CWD`), never the gateway's. The result carries
  `taskId`.
- A failed command prints one line, `swarm: <message>`, and exits non-zero. Add `--verbose`
  for the stack.
- `show` includes the handover timeline from `events.jsonl`: `handovers` (each routed event
  with `seq`, `ts` in unix ms, `event`, `from`, `to`, `sha`, `sinceStartMs`, `sincePrevMs`),
  `startedAt`, `endedAt` (null while open), `durationMs`, and `activeMs` per role (time from a
  delivery to that role until its next emit). The human output prints it as a table.

- `show` reports the repo head as the task sha.
- `answer` is the only operator side channel: it appends an `OPERATOR` event to `events.jsonl`
  and delivers the message to the taskmaster as an ordinary message (it waits behind any run
  still active there).

The same operations are gateway methods: `swarm.start`, `swarm.list`, `swarm.show`,
`swarm.cancel`, `swarm.answer`.

A task id is used once. A finished or cancelled task keeps its state on disk so `swarm show`
still works, so start a new run under a new id.

## How a task flows

1. `swarm start` briefs the build worker and tells the taskmaster the task has begun.
2. Each worker ends every turn by calling the `swarm_emit` tool with an event, the commit sha, and
   a body. The tool is only available inside swarm sessions; the caller's task and role come from
   its session, never from tool arguments.
3. The plugin logs the event to `events.jsonl` and routes it by the contract's table:
   `BUILD_DONE` to audit, `AUDIT_FAIL` back to build, `AUDIT_PASS` to test, `TEST_FAIL` back to
   build, `TEST_PASS` to the taskmaster, `BLOCKED` to the taskmaster.
4. The taskmaster emits `DONE` (or `BLOCKED` / `FAILED`), which goes to the upstream session and
   closes the task.

The sha in an event is information: it is logged and passed on as sent, never refused. Every
emit is routed, so a worker that emits `BLOCKED` and later `BUILD_DONE` for the same input has
both delivered.

One run at a time per session: a message for a session whose run has not settled (including a
re-prompt or a retry after an error) waits and is delivered when that run ends. The swarm never
starts a second run in a session and never aborts a run to re-prompt it.

## When something goes wrong

| Situation                                              | What happens                                                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A worker ends a turn without `swarm_emit`              | The taskmaster is told; it re-prompts once, then escalates `BLOCKED`.                                                                                                                         |
| A run ends in an error                                 | The same input is retried once, then `FAILED` goes upstream.                                                                                                                                  |
| A worker runs on a model other than its contract model | The run is stopped, its emits are refused, and `BLOCKED` goes upstream.                                                                                                                       |
| Quota or rate-limit error                              | `BLOCKED` goes upstream at once, with the reason.                                                                                                                                             |
| The task passes `budget.wall` with no upstream report  | `BLOCKED` goes upstream.                                                                                                                                                                      |
| The gateway restarts                                   | Unacknowledged messages are resent (unless the target transcript already has them), and every session whose last input has no emit and no active run gets that input again, on every restart. |
| An upstream channel is missing or fails                | Logged as `UPSTREAM_CHANNEL_FAILED`; the task carries on.                                                                                                                                     |

A long run is never treated as silence; a worker is silent only when its run ends without an
emit. The only deadline is `budget.wall`, and it never moves work forward on its own.

## State on disk

```
<gateway state dir>/swarm/
  tasks.json
  <task-id>/contract.yaml
  <task-id>/events.jsonl
  <task-id>/outbox.jsonl
```

## Sessions

`agent:<agentId>:swarm:<task-id>:<role>`, with `<role>` one of the contract's workers or
`taskmaster`. Each is labeled `swarm:<task-id>:<role>`.
