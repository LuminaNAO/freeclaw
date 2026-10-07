import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SwarmEngine } from "./engine.js";
import { readEvents, readTasksIndex, writeTasksIndex } from "./store.js";
import { seedTask } from "./test-fixtures.js";
import { makeStubRuntime } from "./test-runtime.js";
import { TASKMASTER_LOST, WallDeadline, type Clock } from "./wall.js";

// budget.wall (ARCH §7 "Taskmaster dies"); there is no step-silence timer (ARCH §7, §10.8).

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-wall-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TASK = "task-500";
const HOUR = 3_600_000;

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

function setup() {
  const clock = new FakeClock();
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  seedTask(stateDir, {
    taskId: TASK,
    headSha: "aa11",
    upstreamSessionKey: "agent:main:up",
  });
  const index = readTasksIndex(stateDir);
  index[TASK] = { ...index[TASK]!, createdAt: new Date(clock.t).toISOString() };
  writeTasksIndex(stateDir, index);
  const runtime = makeStubRuntime();
  const engine = new SwarmEngine({ stateDir, runtime });
  return {
    clock,
    stateDir,
    runtime,
    engine,
    wall: new WallDeadline(engine, clock),
  };
}

describe("wall deadline (ARCH §7)", () => {
  it("arms exactly one timer per open task, at createdAt + budget.wall, whatever runs are live", () => {
    const { clock, wall } = setup();
    wall.armAll();
    wall.arm(TASK);
    expect(clock.timers.map((t) => t.at)).toEqual([clock.t + 4 * HOUR]);
  });

  it("past budget.wall with no upstream report, escalates BLOCKED once", async () => {
    const { runtime, wall, stateDir } = setup();
    await wall.fire(TASK);
    await wall.fire(TASK);
    expect(readEvents(stateDir, TASK).filter((e) => e.event === TASKMASTER_LOST)).toHaveLength(1);
    const up = runtime.runs.filter((r) => r.sessionKey === "agent:main:up");
    expect(up).toHaveLength(1);
    expect(up[0]?.message).toMatch(/budget.wall/);
  });

  it("does nothing for a task that already reported upstream or is closed", async () => {
    const { runtime, wall, engine, clock } = setup();
    engine.close(TASK, "done");
    wall.armAll();
    expect(clock.timers).toHaveLength(0);
    await wall.fire(TASK);
    expect(runtime.runs).toHaveLength(0);
  });

  it("stop() clears every timer", () => {
    const { clock, wall } = setup();
    wall.armAll();
    wall.stop();
    expect(clock.timers).toHaveLength(0);
  });
});
