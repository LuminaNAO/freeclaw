import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatRounds } from "./cli.js";
import { continueTask, parseFollowUp } from "./continue.js";
import { createSwarmEmitTool } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import { createSwarmHooks } from "./hooks.js";
import { resumeOpenTasks, RESTART_LINE } from "./resume.js";
import { currentRound, ROUND_STARTED, roundLine } from "./rounds.js";
import { readEvents, readTasksIndex, writeTasksIndex } from "./store.js";
import { cancelTask, listTasks, showTask, startTask } from "./tasks.js";
import { makeStubRuntime } from "./test-runtime.js";
import { WallDeadline, type Clock } from "./wall.js";

// ARCH §12: follow-up rounds on the same worker sessions.

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-continue-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TASK = "task-800";
const key = (role: string) => `agent:main:swarm:${TASK}:${role}`;
const UPSTREAM = "agent:main:upstream-0000";
const ROLES = ["build", "audit", "test", "taskmaster"];

const CONTRACT = `id: ${TASK}
kind: build
input: original brief, add a function plus unit test
done_when: unit test passes
workers:
  build: { model: provider-a/model-a, thinking: "off" }
  audit: { model: provider-a/model-a, thinking: "off" }
  test: { model: provider-a/model-a, thinking: "off" }
upstream: { sessionKey: ${UPSTREAM} }
budget: { wall: 4h }
`;

const FOLLOWUP = `input: round two, also handle an empty name
done_when: both unit tests pass
`;

type Runtime = ReturnType<typeof makeStubRuntime>;
type Script = (
  role: string,
  message: string,
) => { event: string; sha: string; body?: string } | null;

/** Plays every live run from `from` on: the agent emits per script, then the run settles. */
async function drive(engine: SwarmEngine, runtime: Runtime, script: Script, from = 0) {
  let handled = from;
  for (let guard = 0; guard < 50 && handled < runtime.runs.length; guard += 1) {
    const run = runtime.runs[handled++]!;
    if (!run.sessionKey.includes(":swarm:")) {
      await runtime.end(run.sessionKey); // upstream reads its report; its session is free again
      continue;
    }
    const action = script(run.sessionKey.split(":").pop()!, run.message);
    if (action) {
      await createSwarmEmitTool({ engine, callerSessionKey: run.sessionKey }).execute("c", {
        body: "",
        ...action,
      });
    }
    await runtime.end(run.sessionKey);
  }
  return handled;
}

const happy =
  (sha: string, kickoff: string): Script =>
  (role, msg) => {
    if (role === "build" && msg.includes(kickoff)) {
      return { event: "BUILD_DONE", sha };
    }
    if (role === "audit") {
      return { event: "AUDIT_PASS", sha };
    }
    if (role === "test") {
      return { event: "TEST_PASS", sha };
    }
    if (role === "taskmaster" && msg.includes("TEST_PASS")) {
      return { event: "DONE", sha };
    }
    return null;
  };

function setup() {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = makeStubRuntime();
  const engine = new SwarmEngine({ stateDir, runtime });
  createSwarmHooks(() => engine).attach(engine);
  return { stateDir, runtime, engine };
}

async function doneTask() {
  const ctx = setup();
  await startTask(ctx.engine, { contractYaml: CONTRACT });
  const handled = await drive(ctx.engine, ctx.runtime, happy("aaa0001", "TASK_STARTED"));
  expect(readTasksIndex(ctx.stateDir)[TASK]?.status).toBe("done");
  return { ...ctx, handled };
}

/** Session id each role's runs went to, from the stub session store. */
function sessionIdsByRole(runtime: Runtime, fromRun = 0, toRun = runtime.runs.length) {
  const out: Record<string, Set<string>> = {};
  runtime.runs.slice(fromRun, toRun).forEach((r, i) => {
    const role = r.sessionKey.split(":").pop()!;
    if (!r.sessionKey.includes(":swarm:")) {
      return;
    }
    (out[role] ??= new Set()).add(runtime.runSessionIds[fromRun + i]!);
  });
  return out;
}

describe("follow-up file (ARCH §12)", () => {
  it("accepts input, with optional done_when and budget.wall", () => {
    expect(parseFollowUp("input: more\n")).toEqual({ input: "more" });
    expect(parseFollowUp("input: more\ndone_when: x\nbudget: { wall: 30m }\n")).toEqual({
      input: "more",
      done_when: "x",
      budget: { wall: "30m" },
    });
  });

  it("refuses any other key, a missing input and a bad wall", () => {
    for (const bad of [
      "input: x\nrepo: /elsewhere\n",
      "input: x\nworkers: {}\n",
      "input: x\nid: task-801\n",
      "input: x\nbudget: { wall: 1h, step_silence: 5m }\n",
    ]) {
      expect(() => parseFollowUp(bad)).toThrow(/not allowed/);
    }
    expect(() => parseFollowUp("done_when: x\n")).toThrow(/input is required/);
    expect(() => parseFollowUp("input: x\nbudget: { wall: soon }\n")).toThrow(/invalid duration/);
    expect(() => parseFollowUp("- input\n")).toThrow(/mapping/);
  });
});

describe("swarm continue (ARCH §12)", () => {
  it("a done task: the same session ids receive the round-2 kickoff, round 2 runs to DONE, round 1 untouched", async () => {
    const { stateDir, runtime, engine, handled } = await doneTask();
    const round1Ids = sessionIdsByRole(runtime, 0, handled);
    const round1Events = fs
      .readFileSync(path.join(stateDir, "swarm", TASK, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const upstreamBefore = runtime.runs.filter((r) => r.sessionKey === UPSTREAM).length;

    const res = await continueTask(engine, TASK, { followUpYaml: FOLLOWUP });
    expect(res).toMatchObject({ taskId: TASK, round: 2, status: "open" });
    expect(res.sessions).toEqual(Object.fromEntries(ROLES.map((r) => [r, key(r)])));
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("open");

    // The kickoff went to build and the taskmaster, in the same sessions (by id, not key).
    const kick = runtime.runs.slice(handled);
    expect(kick.map((r) => r.sessionKey)).toEqual([key("build"), key("taskmaster")]);
    expect(runtime.runSessionIds[handled]).toBe([...round1Ids.build!][0]);
    expect(runtime.runSessionIds[handled + 1]).toBe([...round1Ids.taskmaster!][0]);

    // Only the new input plus the round line; not the original brief.
    const buildMsg = kick[0]!.message;
    expect(buildMsg).toContain(`EVENT ${ROUND_STARTED} @`);
    expect(buildMsg).toContain(roundLine(2, TASK));
    expect(buildMsg).toContain(
      `[round 2 of task ${TASK}: you already hold this task's context; re-read only what changed]`,
    );
    expect(buildMsg).toContain("round two, also handle an empty name");
    expect(buildMsg).not.toContain("original brief");
    expect(kick[0]!.extraSystemPrompt).not.toContain("original brief");
    expect(kick[0]!.extraSystemPrompt).toContain("Done when: both unit tests pass");

    const handled2 = await drive(engine, runtime, happy("bbb0002", ROUND_STARTED), handled);
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
    expect(runtime.runs.filter((r) => r.sessionKey === UPSTREAM)).toHaveLength(upstreamBefore + 1);

    // Every role ran round 2 in the very session id it used in round 1.
    const round2Ids = sessionIdsByRole(runtime, handled, handled2);
    for (const role of ROLES) {
      expect(round2Ids[role]).toEqual(round1Ids[role]);
      expect(round2Ids[role]?.size).toBe(1);
    }

    // Round 1 events are untouched; the log, seq and outbox continue.
    const after = fs
      .readFileSync(path.join(stateDir, "swarm", TASK, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(after.slice(0, round1Events.length)).toEqual(round1Events);
    const events = readEvents(stateDir, TASK);
    const round = events.find((e) => e.event === ROUND_STARTED)!;
    expect(round.seq).toBe(round1Events.length + 1);
    expect(round.data).toMatchObject({ round: 2, input: "round two, also handle an empty name" });
    expect(
      events
        .filter((e) => e.kind === "emit" && e.seq > round.seq)
        .map((e) => `${e.from}:${e.event}@${e.sha}`),
    ).toEqual([
      "build:BUILD_DONE@bbb0002",
      "audit:AUDIT_PASS@bbb0002",
      "test:TEST_PASS@bbb0002",
      "taskmaster:DONE@bbb0002",
    ]);
  });

  it("does not re-patch models to anything but the contract's, and sessions keep their keys", async () => {
    const { runtime, engine } = await doneTask();
    const before = runtime.patches.length;
    await continueTask(engine, TASK, { followUpYaml: FOLLOWUP });
    const patches = runtime.patches.slice(before);
    expect(patches.map((p) => p.sessionKey).toSorted()).toEqual(
      [key("audit"), key("build"), key("test")].toSorted(),
    );
    expect(patches.every((p) => p.model === "provider-a/model-a")).toBe(true);
  });

  it("an open task whose workers are all idle can be continued", async () => {
    const { stateDir, runtime, engine } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    await runtime.endAll(); // every kickoff run settled without an emit
    const res = await continueTask(engine, TASK, { followUpYaml: FOLLOWUP });
    expect(res.round).toBe(2);
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("open");
  });

  it("refuses a busy open task (points at swarm answer) and writes nothing", async () => {
    const { stateDir, runtime, engine } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    const log = fs.readFileSync(path.join(stateDir, "swarm", TASK, "events.jsonl"), "utf8");
    const runs = runtime.runs.length;
    await expect(continueTask(engine, TASK, { followUpYaml: FOLLOWUP })).rejects.toThrow(
      /active run.*swarm answer/,
    );
    expect(fs.readFileSync(path.join(stateDir, "swarm", TASK, "events.jsonl"), "utf8")).toBe(log);
    expect(runtime.runs).toHaveLength(runs);
  });

  it("refuses a cancelled task", async () => {
    const { engine, runtime } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    await cancelTask(engine, TASK);
    await runtime.endAll();
    await expect(continueTask(engine, TASK, { followUpYaml: FOLLOWUP })).rejects.toThrow(
      /cancelled/,
    );
  });

  it("refuses a follow-up file with an unknown key before touching the task", async () => {
    const { stateDir, runtime, engine } = await doneTask();
    const runs = runtime.runs.length;
    await expect(
      continueTask(engine, TASK, { followUpYaml: "input: x\nrepo: /other\n" }),
    ).rejects.toThrow(/followup.repo is not allowed/);
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
    expect(readEvents(stateDir, TASK).some((e) => e.event === ROUND_STARTED)).toBe(false);
    expect(runtime.runs).toHaveLength(runs);
  });

  it("reads the follow-up from a file", async () => {
    const { engine } = await doneTask();
    const file = path.join(tmp, "followup.yaml");
    fs.writeFileSync(file, FOLLOWUP);
    expect((await continueTask(engine, TASK, { followUpPath: file })).round).toBe(2);
  });

  it("a third round numbers itself and done_when stays replaced", async () => {
    const { stateDir, runtime, engine, handled } = await doneTask();
    await continueTask(engine, TASK, { followUpYaml: FOLLOWUP });
    const h2 = await drive(engine, runtime, happy("bbb0002", ROUND_STARTED), handled);
    const res = await continueTask(engine, TASK, { followUpYaml: "input: round three\n" });
    expect(res.round).toBe(3);
    expect(runtime.runs[h2]?.message).toContain(roundLine(3, TASK));
    expect(runtime.runs[h2]?.extraSystemPrompt).toContain("Done when: both unit tests pass");
    expect(currentRound(readEvents(stateDir, TASK)).round).toBe(3);
  });

  it("ARCH §8 per round: a gateway restart mid-round 2 resumes round 2 and it finishes", async () => {
    const { stateDir, runtime, engine, handled } = await doneTask();
    await continueTask(engine, TASK, { followUpYaml: FOLLOWUP });
    // Build answers round 2, audit gets it, then the gateway dies.
    await drive(
      engine,
      runtime,
      (role, msg) =>
        role === "build" && msg.includes(ROUND_STARTED)
          ? { event: "BUILD_DONE", sha: "ccc0002" }
          : null,
      handled,
    );
    const runtime2 = makeStubRuntime();
    const engine2 = new SwarmEngine({ stateDir, runtime: runtime2 });
    createSwarmHooks(() => engine2).attach(engine2);
    const summary = await resumeOpenTasks(engine2);
    expect(summary.tasks).toBe(1);
    // Round 1's DONE does not close round 2.
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("open");
    const audit = runtime2.runs.filter((r) => r.sessionKey === key("audit"));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.message.split("\n")[0]).toBe(RESTART_LINE);
    expect(audit[0]?.message).toContain("review ccc0002");
    // Build already answered round 2: it is not re-prompted.
    expect(runtime2.runs.some((r) => r.sessionKey === key("build"))).toBe(false);
    await drive(engine2, runtime2, (role, msg) => {
      if (role === "audit") {
        return { event: "AUDIT_PASS", sha: "ccc0002" };
      }
      if (role === "test") {
        return { event: "TEST_PASS", sha: "ccc0002" };
      }
      if (role === "taskmaster" && msg.includes("TEST_PASS")) {
        return { event: "DONE", sha: "ccc0002" };
      }
      return null;
    });
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
  });

  it("list shows the round; show groups the timeline by round", async () => {
    const { stateDir, runtime, engine, handled } = await doneTask();
    expect(listTasks(stateDir)[0]?.round).toBe(1);
    expect(showTask(engine, TASK).rounds).toHaveLength(1);
    await continueTask(engine, TASK, { followUpYaml: FOLLOWUP });
    await drive(engine, runtime, happy("bbb0002", ROUND_STARTED), handled);
    expect(listTasks(stateDir)[0]).toMatchObject({ id: TASK, round: 2, status: "done" });
    const shown = showTask(engine, TASK);
    expect(shown.round).toBe(2);
    expect(shown.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(shown.rounds[0]?.input).toContain("original brief");
    expect(shown.rounds[1]?.input).toBe("round two, also handle an empty name");
    expect(shown.rounds[0]?.handovers.map((h) => h.event)).toEqual([
      "TASK_STARTED",
      "BUILD_DONE",
      "AUDIT_PASS",
      "TEST_PASS",
      "DONE",
    ]);
    expect(shown.rounds[1]?.handovers.map((h) => `${h.event}@${h.sha}`)).toEqual([
      `${ROUND_STARTED}@${shown.rounds[1]?.handovers[0]?.sha}`,
      "BUILD_DONE@bbb0002",
      "AUDIT_PASS@bbb0002",
      "TEST_PASS@bbb0002",
      "DONE@bbb0002",
    ]);
    expect(shown.rounds[0]?.endedAt).not.toBeNull();
    expect(shown.rounds[1]?.endedAt).not.toBeNull();
    const lines = formatRounds(shown);
    expect(lines.filter((l) => /^round \d/.test(l))).toEqual([
      expect.stringMatching(/^round 1 \(seq \d+\)\s+original brief/),
      expect.stringMatching(/^round 2 \(seq \d+\)\s+round two/),
    ]);
  });
});

class FakeClock implements Clock {
  t = Date.parse("2026-01-01T00:00:00.000Z");
  timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private next = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
}

describe("per-round wall budget (ARCH §12)", () => {
  it("the round's wall starts at ROUND_STARTED and uses the follow-up's budget.wall", async () => {
    const { stateDir, runtime, engine } = await doneTask();
    const clock = new FakeClock();
    const wall = new WallDeadline(engine, clock);
    // Pretend the task was created long ago: round 1's wall would already be past.
    const index = readTasksIndex(stateDir);
    index[TASK] = { ...index[TASK]!, createdAt: "2020-01-01T00:00:00.000Z" };
    writeTasksIndex(stateDir, index);
    await continueTask(engine, TASK, {
      followUpYaml: "input: round two\nbudget: { wall: 30m }\n",
    });
    const round = readEvents(stateDir, TASK).find((e) => e.event === ROUND_STARTED)!;
    clock.t = round.ts;
    wall.rearm(TASK);
    expect(clock.timers.map((t) => t.at)).toEqual([round.ts + 30 * 60_000]);

    // Round 1's upstream DONE does not count as round 2's report: the wall escalates.
    await runtime.endAll();
    const before = runtime.runs.filter((r) => r.sessionKey === UPSTREAM).length;
    await wall.fire(TASK);
    const up = runtime.runs.filter((r) => r.sessionKey === UPSTREAM);
    expect(up).toHaveLength(before + 1);
    expect(up.at(-1)?.message).toMatch(/budget.wall \(30m\)/);
  });

  it("without budget.wall in the follow-up, the round uses the contract's wall from ROUND_STARTED", async () => {
    const { stateDir, engine } = await doneTask();
    const clock = new FakeClock();
    const wall = new WallDeadline(engine, clock);
    await continueTask(engine, TASK, { followUpYaml: FOLLOWUP });
    const round = readEvents(stateDir, TASK).find((e) => e.event === ROUND_STARTED)!;
    clock.t = round.ts;
    wall.arm(TASK);
    expect(clock.timers.map((t) => t.at)).toEqual([round.ts + 4 * 3_600_000]);
  });
});
