# Holonic swarm — ARCH (v2 of extensions/swarm)

Source of truth for `extensions/swarm`. Owned by the operator; engineers do not edit it. Architecture-driven: no
separate spec; each commit names the section it implements. A conflict is a defect: raise `BLOCKED`, do not
resolve it in code. v2 replaces the v1 ARCH; everything v1 does keeps working (§11).

Background: a **holon** (Koestler) is a whole that is also a part of a larger whole. It runs itself within rules
handed down from above, reports up as one unit, and escalates only what falls outside its rules. A tree of holons
is a **holarchy**; every level has the same shape.

## 1. Principles
1. **Lean.** Plain files, no database, no new dependency, no money, no time or token limits, no timers, no
   scheduler service. Fewest moving parts wins.
2. **Every holon has the same shape** (§2), from "fix this test file" to "build a website". A task is a holon.
3. **Nothing just dies.** Every participant turn MUST end by pushing forward, returning backward, or reporting up
   (v1 exit enforcement, kept). A holon that cannot proceed escalates; it never goes quiet.
4. **Stack, don't interrupt.** Work piled onto a holon or a participant queues behind the current turn and is
   delivered together next turn (freeclaw `collect` + the session prompt stack). Only `urgent` (stop, rules
   changed) interrupts. Nothing is lost on a gateway restart.
5. **Rules down, summaries up.** A holon gets its rules (canon) from its parent and may only tighten them for its
   children. It reports up as one unit (status, progress, blockers), never raw chatter.
6. **One level at a time.** A holon talks to its parent and its own children only. Escalation climbs one level at
   a time.
7. **Durable by file**, one folder per holon. A crash loses at most the turn in flight, never the tree.
8. **Generic.** No person, agent, number, group, host or org path in code. Everything comes from the holon file
   or plugin config.

## 2. The holon (`<stateDir>/swarm/<root-id>/<path>/holon.yaml`)
```yaml
id: website-acme              # human-readable, unique within its parent: <repo-or-area>-<plain words>
goal: <what and why, plain language>
done_when: <checkable condition>
lead: { kind: agent, model: <provider/model>, thinking: high }      # or { kind: human, channel: <target> }
recipe: build-audit-test      # optional; or omitted = the lead plans the structure itself
lanes:                        # optional; the work inside this holon (§4)
  build: { count: 3, model: <provider/model>, thinking: off, partition: true }
  audit: { count: 5, model: [<m1>, <m2>], thinking: high, join: all }
  test:  { count: 1, model: <provider/model>, thinking: off }
children: []                  # child holon ids, each its own holon.yaml in a sub-folder (§5)
canon:                        # rules from the parent; children may only tighten
  scope: <paths / repo / area>
  never: [push, merge, deploy]  # actions forbidden in this subtree
  approve: [plan]             # gates that need the parent lead's yes (default: none)
  depth: 3                    # how many more child levels are allowed
repo: <path>                  # optional working checkout
upstream: { sessionKey: <optional>, channel: <optional> }   # root only; children report to their parent
```
- A holon's **state** is derived from its event log (`events.jsonl`): `planning | running | blocked | done |
  failed | cancelled`. No separate state file.
- **Participants** are the lead plus every lane member. Each agent participant is its own session
  `agent:<a>:swarm:<root>:<path>:<role>[:<n>]`; its `model`/`thinking` are applied to the session, never just
  mentioned.

## 3. Leads (any model, or a human)
1. The lead owns the holon: plans its lanes/children within the canon, drives them, judges results, reports up.
   The v1 "taskmaster" is exactly an agent lead.
2. **Agent lead:** any configured model, set per holon (`lead.model`, `lead.thinking`). No more dependence on the
   gateway default model.
3. **Human lead:** the holon's events addressed to the lead are sent to `lead.channel` as short plain messages
   (one line: what happened, what is needed). The human answers in plain chat. A small **relay session** for
   that holon reads the reply and turns it into exactly one routed event (e.g. `APPROVED`, `RETRY`, `BLOCKED`,
   `DONE`), confirming back what it understood. The relay never decides on its own; if a reply is unclear it
   asks once. No commands for the human to learn.
4. The parent lead picks a child's lead; the root owner (whoever started the root) can override any lead
   (`swarm lead <holon> <spec>`).

## 4. Lanes and fan-out (inside one holon)
1. A lane is a role with `count` ≥ 1 members. v1's single build → audit → test is the special case count = 1.
2. **Partitioned lane** (`partition: true`, builders): the lead splits the work into `count` scopes, written into
   the holon's `plan.md` (one line each). Member n gets scope n and its own branch/worktree
   `<holon-branch>-p<n>`. When all members are done, the lead (or a named `integrate` role) merges them into
   the holon branch and emits one `BUILD_DONE` for the merged head.
3. **Redundant lane** (auditors/testers): every member gets the same input. `model` may be a list; members cycle
   through it so blind spots differ.
4. **Join** (per lane, default `all`): `all` = every member passes on the same head; `quorum:<k>` = k passes
   proceed and every dissenting finding is answered by build and re-checked by its dissenter; `any` = first pass
   wins, the rest are told to stop. The join **deduplicates findings** so build receives one list.
5. The join is done by the lead from the members' events; there is no join service. A lane's result is one event
   upward to the lead (`AUDIT_PASS`/`AUDIT_FAIL` with the merged findings), so routing (§6) stays linear.

### 4.6 Every verdict joins, whatever its route (operator, 2026-11-02)
Found live (a 3-tester `join: all` lane, one TEST_FAIL and two TEST_PASS on the same head): the lane never settled
and the holon sat idle for 39 minutes. Cause: a member verdict whose route goes to the lead or upstream (TEST_PASS →
lead) skipped the join and reached the lead raw, while the same lane's FAIL (routed to build) went through the join;
the join then waited forever for members whose verdicts had already bypassed it.
1. A member's verdict (any PASS/FAIL pair the join understands) **always** goes through its lane's join, whatever
   its route target (a lane, the lead, or upstream). Only non-verdict events (BLOCKED, QUESTION, …) pass straight.
2. When the lane settles, exactly one event goes to the route's target: the PASS for a pass, or the merged findings
   for a fail (a fail always goes to the lead, which hands it to build). The lead never sees raw member verdicts.
3. Invariant (tested): once every member of a lane has emitted a verdict for the current round, the lane is settled.
   No combination of routes can leave it waiting.

### 4.7 Nobody waits on nothing (operator, 2026-11-02)
Event-driven, no timers (§7 "no time limits" stays):
1. When a member's turn ends and its lane is unsettled for the round, the engine checks whether any member of that
   lane still has a turn in flight or a queued input. If none does, the lead gets one `LANE_STALLED` event naming the
   lane, the join status, and the members with no verdict this round; each such member is re-prompted once
   (as a silent participant, §7). Never repeated for the same round.
2. The lead brief says: on `LANE_WAITING`, wait (the engine guarantees a follow-up); on `LANE_STALLED`, decide
   (re-prompt, RETRY, or BLOCKED up). A lead never ends a round on NO_REPLY without one of those coming.
3. `LANE_WAITING` records its lane in `data.lane` (it was missing), so `swarm show` and resume can see unsettled lanes.

Tests: replay of the exact live sequence (test:1 TEST_FAIL, test:2/test:3 TEST_PASS, join all) settles as a fail
with test:1's findings; all-pass sends the lead one TEST_PASS, not three; quorum/any unchanged; a lane whose last
idle member has no verdict emits LANE_STALLED once and re-prompts it; resume of a holon with an unsettled lane
re-checks §4.7.1. All existing swarm tests stay green.

## 5. Child holons (the holarchy)
1. A lead may create child holons within its canon and `depth` (`swarm spawn` from the lead's session, or by
   writing the child `holon.yaml` through the tool the plugin gives leads). Example: "fix the test suite" →
   three children `lane-a`, `lane-b`, `lane-c`, each a build/audit/test holon on its own scope and branch.
2. A child inherits the canon; any loosening is refused at spawn (e.g. a child cannot drop `never: [push]` or
   add a scope outside the parent's).
3. A child reports to its parent lead only: `CHILD_DONE`, `CHILD_BLOCKED`, `CHILD_FAILED`, each with a 1-5 line
   summary. The parent decides what to do (integrate, retry, re-plan, escalate).
4. **Escalation:** anything outside a holon's canon, or a `BLOCKED` its lead cannot resolve, goes to the parent
   lead; if that lead is also stuck it goes one more level; the root escalates to `upstream`. There are no timers:
   silence is impossible by construction, because every turn must emit (§6.3).

## 6. Messages and routing (v1 §4-§5, kept)
1. Every handoff is an agent message with the v1 header, extended with the holon path:
   `TASK <root>/<path> | FROM <role[:n]> | TO <role|lead|parent>` / `EVENT <name> @ <sha>` / body.
2. Routing is data per recipe (v1 §5 table), plus the fan-out rules of §4 and the child rules of §5. Every emit is
   routed; the sha is information, not a gate.
3. **Exit enforcement (kept):** a participant turn that ends without a routed event is invalid; the lead is told,
   re-prompts once, then escalates. Applies to agent leads as well (their parent re-prompts them).
4. **Stacking (principle 4):** messages to a busy session queue (`collect`); a holon can be given more work at any
   time with `swarm add <holon> <file>` — it is queued to the lead like any other message, never interrupting.
   `urgent: true` messages steer.

## 7. Exceptions (v1 §7, kept) and resume (v1 §8, kept)
- Run error, quota, provider down, gateway restart, silent participant: exactly as v1, applied per participant.
- Resume walks every open holon in the tree, resends unacknowledged outbox entries, and re-delivers each
  session's last undelivered input (until the gateway prompt stack covers it). Children resume independently;
  a crash in one branch never blocks its siblings.
- **No time or token limits.** A holon runs until it is done, blocked, failed or cancelled. Old contracts'
  `budget` fields are accepted and ignored.

## 8. Groups and visibility
1. A holon that has a human participant gets one channel group (members: those humans, the root owner, the
   agent identity running it), named `<root> · <holon id>`; closed when the holon is done. Agent-only holons get
   no group (session switching, as v1).
2. A participant sees its own holon plus the summaries of its parent and children; the root owner can read
   everything (`swarm show <root> --tree`).
3. No channel configured or available → everything still runs; humans are then unreachable and their holons
   escalate as `BLOCKED: no channel`.

## 9. Commands
`swarm start <holon.yaml>` · `swarm list` (tree view, one line per holon: path, state, lead, age) ·
`swarm show <holon> [--tree] [--json]` · `swarm add <holon> <file>` · `swarm answer <holon> <msg>` ·
`swarm lead <holon> <spec>` · `swarm cancel <holon>` (cancels its subtree) · `swarm continue` (v1 §12, kept).
Every read works with the gateway down (reads the files).

## 10. v2 build order
1. Holon file + tree folders + derived state + per-holon lead model (§2, §3.1-3.2). v1 contracts load as a root
   holon with one lane per role.
2. Fan-out lanes: partition, redundancy, join `all | quorum | any`, findings dedup (§4).
3. Child holons, canon inheritance and refusal of loosening, one-level escalation (§5).
4. Stacking command `add`, tree `list/show`, `lead` override (§6.4, §9).
5. Human lead/participant via channel + relay session; groups for holons with humans (§3.3, §8).

## 10a. Steps 3-5 build notes (operator, 2026-11-02)
Applies the house standard (one ops core, thin frontends): every new capability (spawn, add, lead override, relay,
group open/close) is an engine/ops function first; the `swarm` CLI (`--json`), the lead's tool and the relay call the
same functions. Generic: no person, number, group id, host or org in code; humans and channels come from the holon
file or the parent's canon.
1. **Step 3, child holons (§5):** `swarm spawn` (CLI + lead tool) writes the child holon.yaml under the parent's
   folder; canon inheritance refuses any loosening at spawn with the exact key named; `CHILD_DONE/BLOCKED/FAILED`
   (1-5 line summary) route to the parent lead only; escalation climbs one level at a time to upstream. `swarm list`
   shows the tree; resume walks the tree (§7).
2. **Step 4 (§6.4, §9):** `swarm add <holon> <file>` queues work to the lead (never interrupts; `urgent: true`
   steers); `swarm show <root> --tree`; `swarm lead <holon> <spec>` (root owner only).
3. **Step 5, humans over a channel (§3.3, §8):** `lead: { kind: human, who: [<channel id>…], channel: <channel> }`
   and `participants: [{ kind: human, who, channel, role }]`.
   - Group: on first need the engine creates one channel group per holon with humans (members: those humans, the
     root owner, the agent identity), name `<root> · <holon id>`, through the channel plugin's group API (Signal:
     the existing signal-cli JSON-RPC `updateGroup`, resolved by account, never by port). Closed (left + renamed
     `[done]`) when the holon is done. The group id is recorded in the holon's events.
   - Outbound: events addressed to a human lead/participant become one short plain line (what happened, what is
     needed, the sha) in that group.
   - Relay: a small relay session per holon (model from canon, default the lead model) reads each human reply in
     that group and emits **exactly one** routed event, then confirms back in one line what it understood. Unclear →
     asks once. It never decides on its own and has no tools except swarm_emit and the reply.
   - No channel available → `BLOCKED: no channel` up one level (§8.3).
4. **Tests:** fake channel (loopback) for groups and relay: a human lead approves a plan in plain words and the relay
   emits APPROVED once; an unclear reply gets one question; a child spawn that drops `never: [push]` is refused; three
   children finish and the root integrates; `add` mid-turn queues; resume after two gateway kills finishes every
   holon; parity gate: every new op has a CLI verb with `--json` and the lead/relay tool calls the same function;
   all existing swarm tests green. §12.2, §12.3 and §12.6 are the acceptance items for this build.

## 11. Compatibility
Every v1 contract, `continue` round and resume behaviour keeps working unchanged. v1 tests stay green. A v1
contract is a root holon whose lead is the gateway default model (as today) unless `lead` is given.

## 12. Acceptance
1. A dev task whose lead splits it into 3 partitioned builders, 5 redundant auditors (2 models, join `quorum:4`)
   and 1 tester runs to DONE with zero operator messages; findings reach build deduplicated.
2. A root holon spawns 3 child build/audit/test holons on separate scopes; each finishes; the root integrates and
   reports DONE. A child trying to loosen the canon (drop `never: push`) is refused.
3. Work added with `swarm add` while the lead is mid-turn is queued and handled next turn; nothing interrupts.
4. A participant ending a turn without an emit is re-prompted, then escalated one level, never silent.
5. Gateway killed mid-task twice in a row: every open holon in the tree resumes and finishes.
6. A human lead (test channel or a loopback fake channel) approves a plan in plain words; the relay turns it into
   one event and the holon proceeds.
7. All v1 acceptance tests still pass.
