# plan.md — fc-holon-35-1: ARCH §10 steps 3-5 + §10a

Lead plan. Design: extensions/swarm/ARCH.md §3.3, §5, §6.4, §8, §9, §10 steps 3-5, §10a, §12
(operator-owned, never edit it). Base: feature/holon-steps-3-5 @ 3937838751.

Worktrees (already created, one per builder):
- build:1 → worktrees/feature/holon-steps-3-5-p1 (branch …-p1)
- build:2 → worktrees/feature/holon-steps-3-5-p2 (branch …-p2)
- build:3 → worktrees/feature/holon-steps-3-5-p3 (branch …-p3)

House standard (§10a preamble): every new capability is an **engine/ops function first**; the
`swarm` CLI (`--json`), the lead tool and the relay call the same function. No person, number,
group id, host or org path in code.

Repo rules: `pnpm install --frozen-lockfile` first; PATH=/home/claude/.nvm/versions/node/v24.14.1/bin:$PATH;
never CI=true; never touch ports 40700-40799; no live gateways, no signal-cli, no real groups, no pushes.
Commits: small, each naming its ARCH section; author `Lumina Nao <luminanao@duck.com>`, no trailers,
no internal names/hosts/IPs/group ids/home paths. Tests: vitest, run the swarm suite
(`pnpm vitest run extensions/swarm`) plus anything you touch; `pnpm build` must stay green.

---

## Partition 1 (build:1) — Child holons + tree (§5, §10a.1)

Scope: `swarm spawn`, canon inheritance/refusal, CHILD_* routing, escalation one level at a time,
tree `list`, resume over the tree.

New file `src/children.ts` (owns the child-holon ops core) + `src/children.test.ts`. Touch
`holon.ts`, `tasks.ts`, `resume.ts`, `cli.ts`, `methods.ts` minimally.

**Interface contract (partition 3 and 2 depend on this — do not deviate without telling the lead):**

- Holon path: a child lives under its parent's folder:
  `taskDirFor(stateDir, rootId)` + `/children/<child-id>/` (recursively). Helper exported from
  `src/children.ts`:
  - `holonDirFor(stateDir: string, rootId: string, path: string[]): string`
    (`path` = child ids from the root downward; `[]` = the root itself).
  - `holonPathKey(path: string[]): string` → `"<root-id>/<c1>/<c2>"` for TASK headers / show.
  - Each holon folder has its own `holon.yaml`, `events.jsonl`, `outbox.jsonl` (same store code,
    pointed at the holon dir).
- `spawnChild(engine, parentPath: string[], yamlText: string): Promise<{ ok: true; path: string[] } | { ok: false; reason: string }>`
  — parses the child holon.yaml, enforces canon tightening (refusal names the exact key, e.g.
  `canon.never: child drops "push"`; scope outside parent scope; `depth` exhausted), writes the
  child folder, records a `CHILD_SPAWNED` event on the parent.
- Canon check exported as `assertCanonTightens(parent: Canon, child: Canon): void` (throws
  `SwarmContractError` naming the key) so audits/tests can call it directly.
- Child → parent reporting: `CHILD_DONE | CHILD_BLOCKED | CHILD_FAILED` (body = 1-5 line summary)
  route to the **parent lead only**. Escalation: a BLOCKED the lead cannot resolve re-emits one
  level up; the root escalates to `upstream`.
- `listTasks` grows a tree view: `listHolonTree(stateDir, rootId)` returning
  `{ path: string[], state: HolonState, lead: string, ageMs: number }[]` (depth-first); CLI
  `swarm list` renders one line per holon.
- Resume (§7): `resumeOpenTasks` walks every open holon in the tree (depth-first, children
  independent — a crash in one branch never blocks siblings).

Tests (from §10a.4 + §12.2): spawn that drops `never: [push]` refused with the key named; three
children finish and the root integrates (CHILD_DONE × 3 → root lead); resume after simulated
restart finishes children independently; existing swarm tests green.

## Partition 2 (build:2) — add / lead override / show --tree / parity gate (§6.4, §9, §10a.2)

Scope: `swarm add <holon> <file>` (queues to the lead via the existing stacking/collect path,
never interrupts; `urgent: true` in the file's frontmatter steers), `swarm show <holon> [--tree] [--json]`,
`swarm lead <holon> <spec>` (root owner only — refuse otherwise with who may), parity gate.

Ops functions in `src/tasks.ts` (or new `src/ops.ts` if tasks.ts gets crowded):
- `addWork(engine, path: string[], text: string, opts?: { urgent?: boolean })` → queued event
  `WORK_ADDED` + delivery to the lead session using the existing outbox/delivery code.
- `overrideLead(engine, path: string[], spec: string)` → parses `spec` like holon.ts lead
  (`agent:<model>[:thinking]` or `human:<channel>` once p3 lands — until then accept the string,
  validate kind), rewrites holon.yaml lead, records `LEAD_CHANGED`, reapplies the session model.
- `showTree(engine, rootId)` → reuse p1's `listHolonTree` + per-holon `showTask` summary.
  **Until p1 lands:** code against the p1 signatures above (they are the contract); if p1 slips,
  stub `listHolonTree` for the root-only case and mark it TODO(§5).
- Parity gate test (§10a.4): a test that enumerates the new ops (spawn, add, lead, show-tree,
  relay-emit, group open/close) and asserts each has (a) a CLI verb accepting `--json`, and
  (b) the CLI/method handler calls the same exported ops function (assert by identity/spy, not
  by duplicated logic). Build it table-driven so p1/p3 just add rows.

Tests: §12.3 (add mid-turn queues, handled next turn, nothing interrupts), lead override by
root owner succeeds / by anyone else refused, parity table green.

## Partition 3 (build:3) — Humans over a channel (§3.3, §8, §10a.3)

Scope: human lead/participant parsing, channel group lifecycle, outbound one-liners, relay
session, fake loopback channel for tests. **Depends on p1's `holonDirFor`/`holonPathKey`/event
files per holon — code against the contract above.**

- `holon.ts`: extend `LeadSpec` to
  `{ kind: "agent", model?, thinking? } | { kind: "human", who: string[], channel: string }`
  and add `participants?: { kind: "human"; who: string[]; channel: string; role: string }[]`.
  Parse + validate per §10a.3. Keep v1 behaviour untouched (agent default).
- `group.ts`: real adapter interface work. `SwarmGroupAdapter` gains
  `ensureGroup(path, opts: { name: string; members: string[] })` semantics; group name
  `<root> · <holon id>`; group id recorded in the holon's events (`GROUP_OPENED { groupId }`);
  on holon done → leave + rename `[done]` (`GROUP_CLOSED`). Resolution by account, never by
  port — but **do not implement a signal adapter beyond the interface + the fake**: tests use
  only `src/fake-channel.ts`, an in-memory loopback adapter (createGroup/post/read replies)
  registered as kind `"fake"`. Never call signal-cli, never create a real group, never message
  anyone.
- Outbound: events addressed to a human lead/participant render as **one short plain line**
  (what happened, what is needed, the sha) posted to the group.
- Relay: `src/relay.ts` — one relay session per holon (model from canon, default the lead
  model). Reads each human reply, emits **exactly one** routed event (APPROVED, RETRY, BLOCKED,
  DONE …), confirms back in one line. Unclear → asks once, then escalates. No tools except
  swarm_emit + the reply. Engine/ops function first (`relayHumanReply(engine, path, text)`),
  the session wrapper calls it.
- No channel available → `BLOCKED: no channel` up one level (§8.3).

Tests (§10a.4, §12.6): human lead approves a plan in plain words over the fake channel → relay
emits APPROVED exactly once; unclear reply → exactly one question; group opened with the right
name/members and closed `[done]` on DONE; no-channel → BLOCKED one level up. Add your ops to
p2's parity table.

---

## Integration & order

1. p1 lands first (it owns the shared contract). p2/p3 start immediately against the signatures
   above; raise a BLOCKED to the lead if a signature must change — the lead updates this file.
2. When all three emit BUILD_DONE, the lead merges p1 → p2 → p3 into feature/holon-steps-3-5
   and emits one BUILD_DONE for the merged head (§4.2).
3. Shared-file discipline to keep merges clean: p1 owns `children.ts`; p2 owns the parity test
   + CLI verbs for add/lead/show; p3 owns `relay.ts`, `fake-channel.ts`, group.ts internals.
   In shared files (`cli.ts`, `methods.ts`, `holon.ts`, `engine.ts`) add code in clearly
   separated blocks, append rather than reorder, one import block per partition.
4. Done when: §10 steps 3-5 + §10a implemented with the §10a tests, swarm + touched suites and
   `pnpm build` green, both audits pass, tester passes on the merged head.
