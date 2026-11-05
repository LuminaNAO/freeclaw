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
openclaw swarm list [--json]               # holon tree: path, state, lead, age, recent event
openclaw swarm spawn <parent> --file child.yaml [--json]  # child holon under <parent> (ARCH §5)
openclaw swarm show <task-id> [--json]     # models per role, event log, handover timeline
openclaw swarm cancel <task-id> [--reason] # stop every task session, close the task
openclaw swarm answer <task-id> <message>  # answer the taskmaster; logged as OPERATOR
openclaw swarm continue <task-id> --file <followup.yaml>  # next round on the same sessions
openclaw swarm add <holon> <file> [--urgent] [--json]      # queue more work to the holon's lead
openclaw swarm lead <holon> <spec> [--json]                # change a holon's lead (root owner)
openclaw swarm show <holon> --tree [--json]                # the holon plus one line per holon in its tree
```

- `<holon>` is a holon path, `<root>[/<child>...]` (ARCH §2).
- `add` (ARCH §6.4): the file is the work in plain text. It is queued to the lead like any other
  message: a lead mid-turn gets everything added meanwhile as one message on its next turn;
  nothing interrupts. Front matter `urgent: true` (or `--urgent`) steers instead: the lead's
  current turn stops and the added work comes first, followed by anything already queued.
  Logged as `WORK_ADDED`.

  ```markdown
  ---
  urgent: true
  ---

  Rules changed: stop using the old API.
  ```

- `lead` (ARCH §3.4): only the root owner (the operator through the gateway, or the root's
  upstream session) may change a lead; anyone else is refused with who may. `<spec>` is
  `agent`, `agent:<provider/model>[:<thinking>]`, `member:<channel>:<who>[,<who>]`, or a YAML
  mapping as in the holon file. The new model is applied to the lead session first (a refused
  model changes nothing), then `holon.yaml` is rewritten, `LEAD_CHANGED` is logged and the lead
  is told.
- `list` and `show` work with the gateway down: they read the state files directly (ARCH §9).
- Leads also get the `swarm_holon` tool (`op: add | lead | showTree`). It calls the same op
  functions as these verbs (ARCH §10a); a lead adds work only to its own child holons and reads
  only its own holon, its parent and its children (§8.2).

- `start --file` resolves a relative path against the directory you run the command from (or
  the package-manager launch directory, `INIT_CWD`), never the gateway's. The result carries
  `taskId`.
- A failed command prints one line, `swarm: <message>`, and exits non-zero. Add `--verbose`
  for the stack.
- `show` includes the handover timeline from `events.jsonl`: `handovers` (each routed event
  with `seq`, `ts` in unix ms, `event`, `from`, `to`, `sha`, `sinceStartMs`, `sincePrevMs`),
  `startedAt`, `endedAt` (null while open), `durationMs`, and `activeMs` per role (time from a
  delivery to that role until its next emit). The plain (non-`--json`) output prints it as a table.

- `show` reports the repo head as the task sha.
- `answer` is the only operator side channel: it appends an `OPERATOR` event to `events.jsonl`
  and delivers the message to the taskmaster as an ordinary message (it waits behind any run
  still active there).

The same operations are gateway methods: `swarm.start`, `swarm.list`, `swarm.show`,
`swarm.cancel`, `swarm.answer`, `swarm.continue`, `swarm.spawn`.

## Child holons (ARCH §5)

A holon's lead may split its work into child holons, each its own holon (lanes, lead,
sessions, log) in the parent's folder. The lead uses the `swarm_holon` tool (spawn, answer a
child, cancel a child); the operator uses `swarm spawn <parent> --file child.yaml`. Both call
the same function.

- The child inherits the parent's canon. It may only tighten it: add to `never`/`approve`,
  narrow `scope`, ask for fewer `depth` levels. Any loosening is refused at spawn, naming the
  key (for example `canon.never: child drops "push"`). A child has no `upstream`.
- A child without a `lead` gets its parent lead's model.
- A child's `DONE`, `BLOCKED` and `FAILED` go to its parent lead only, as `CHILD_DONE`,
  `CHILD_BLOCKED`, `CHILD_FAILED` with a 1-5 line summary. The root alone reports upstream, so
  escalation climbs one level at a time. A lead cannot report `DONE` while a child is open.
- `swarm cancel <holon>` cancels its whole subtree. `swarm list` prints the tree; a child is
  addressed by its path, `<root>/<child>`.
- Resume walks every open holon in the tree; a broken branch never blocks its siblings, and a
  child report written before a crash reaches its parent exactly once.

A task id is used once. A finished or cancelled task keeps its state on disk so `swarm show`
still works. Start new work under a new id; a follow-up to the same work is a new round of the
same task (`swarm continue`, below).

## Follow-up rounds

`swarm continue <task-id> --file <followup.yaml>` runs another round of a task on the same
worker sessions, so each worker keeps the context it already built.

```yaml
input: Also handle an empty name. # required
done_when: both unit tests pass # optional; replaces the task's from now on
budget: { wall: 1h } # optional; this round only
```

Any other key is refused. The task's contract, sessions, models, thinking, routes, repo and
upstream stay as they are.

- Allowed for a `done` task, or an `open` task with no active run in any of its sessions.
  Refused for a `cancelled` task, and for an open task with an active run (use `swarm answer`
  there).
- Appends `ROUND_STARTED {round, input}` to the same `events.jsonl` (round 1 is the original
  start), sets the task `open` again and sends the kickoff exactly as `start` does, to the same
  session keys. Outbox, seq and the log continue; nothing is reset.
- The kickoff carries only the new input under one line:
  `[round n of task <id>: you already hold this task's context; re-read only what changed]`.
- The round's `budget.wall` starts at `ROUND_STARTED`. Resume after a restart works per round.
- `--file` resolves like `start --file`. `swarm list` shows the round (`r2`); `swarm show`
  returns `round` and `rounds` (one handover timeline per round) and prints them grouped.

## Members over a channel (ARCH §3.3, §8, §10a.3, §10b)

A member is whoever is on the other end of a channel: a person or another agent on its own
gateway. The swarm treats both the same. A holon may have a member lead or member
participants:

```yaml
lead: { kind: member, who: [<channel id>], channel: signal }
participants:
  - { kind: member, who: [<channel id>], channel: signal, role: review }
canon:
  relay: { model: provider/model } # optional; default the lead model
```

- On first need the swarm opens one channel group per holon with members, named
  `<root> · <holon id>`, with those members and the root owner (plugin config
  `members.owners.<channel>`). The group id is recorded as `GROUP_OPENED` in the holon's
  events. When the holon is done the group is renamed `… [done]` and left (`GROUP_CLOSED`).
  Agent-only holons never get a group.
- An event addressed to a member becomes one plain line in that group: the sender's own
  words only (no event name, role, sha or route note; folded to one line, cut at 280
  characters with `…`). The event, role and sha stay in the events (`swarm show`). Lead
  briefs say to write member-addressed bodies as one plain line for that member (ARCH §10b.5).
- A member's reply goes to the holon's relay session (`<task>:relay`), which turns it into
  exactly one routed event from that member's role (e.g. `APPROVED`, `RETRY`, `BLOCKED`,
  `DONE`) and confirms in one line. Unclear replies get one question (`ASK`), never two. The
  relay has no tool but `swarm_emit`; a relay turn without an emit is re-prompted once, then
  reported `BLOCKED` with the member's words.
- No channel configured or the group cannot be created: everything else runs, and the holon
  reports `BLOCKED: no channel` one level up, once.

```json
{
  "swarm": {
    "config": {
      "members": {
        "channels": { "signal": { "accountId": "default" } },
        "owners": { "signal": ["<owner channel id>"] }
      }
    }
  }
}
```

`fake` is an in-process loopback channel for tests and dry runs; it never leaves the process.

Older input keeps working (ARCH §10b.3): the step-5 spellings of `kind: member`, of the
`member:` lead spec and of the `members` plugin config are accepted as aliases, and event
logs written with the step-5 event names are read as `MEMBER_POSTED`, `MEMBER_POST_FAILED`,
`MEMBER_REPLY` and `MEMBER_IGNORED`. Nothing on disk is migrated; new logs write `MEMBER_*`.

```bash
openclaw swarm group open|close <task-id> [--json]           # same op the engine uses
openclaw swarm relay <task-id> <message> --who <id> [--json] # a member reply, as if in the group
```

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

| Situation                                                                          | What happens                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A worker ends a turn without `swarm_emit`                                          | The taskmaster is told; it re-prompts once, then escalates `BLOCKED`.                                                                                                                                                                                                                               |
| A run ends in an error (a provider error ends it, whatever the run status says)    | Logged as `RUN_ERROR`. Timeouts, 5xx, overload and connection or stream errors are retried with the same input after 30 s, 2 min, 5 min, 10 min, then every 15 min, never `FAILED`; every participant, the lead and the relay included. Anything else is retried once, then `FAILED` goes upstream. |
| A worker runs on a model other than its contract model                             | The run is stopped, its emits are refused, and `BLOCKED` goes upstream.                                                                                                                                                                                                                             |
| Quota or rate-limit error                                                          | `BLOCKED` goes upstream at once, with the reason, and the input is retried every 15 min, so the holon resumes on its own.                                                                                                                                                                           |
| The task passes `budget.wall` with no upstream report                              | `BLOCKED` goes upstream.                                                                                                                                                                                                                                                                            |
| The gateway restarts                                                               | Unacknowledged messages are resent (unless the target transcript already has them), and every session whose last input has no emit and no active run gets that input again, on every restart.                                                                                                       |
| An open holon has nothing running, queued or scheduled, but an input is unanswered | Once a minute the swarm checks; that input goes to its owner again (`RESUMED_IDLE`), unless the holon waits on a member, a child or upstream.                                                                                                                                                       |
| An upstream channel is missing or fails                                            | Logged as `UPSTREAM_CHANNEL_FAILED`; the task carries on.                                                                                                                                                                                                                                           |

A long run is never treated as silence; a worker is silent only when its run ends without an
emit (and not in a provider error). The only deadline is `budget.wall`, and it never moves work
forward on its own. The swarm owns exactly two timers (ARCH §7.1): the retry after a run error,
logged as `RETRY_SCHEDULED` and armed again after a restart, and the idle sweep.

## State on disk

```
<gateway state dir>/swarm/
  tasks.json
  <task-id>/contract.yaml
  <task-id>/events.jsonl
  <task-id>/outbox.jsonl
  <task-id>/children/<child-id>/holon.yaml      # child holons, same layout, any depth
```

## Sessions

`agent:<agentId>:swarm:<task-id>:<role>`, with `<role>` one of the contract's workers or
`taskmaster`. Each is labeled `swarm:<task-id>:<role>`. A child holon's sessions put its path
in place of the task id, one segment per level: `agent:<agentId>:swarm:<root>:<child>:<role>`.
