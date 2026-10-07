import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSwarmEmitTool } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import { createSwarmHooks } from "./hooks.js";
import { resumeOpenTasks } from "./resume.js";
import { readEvents, readTasksIndex } from "./store.js";
import { answerTask, startTask } from "./tasks.js";
import { makeStubRuntime } from "./test-runtime.js";

// End-to-end flow with a scripted stand-in for the agents (ARCH §10.1-§10.4, §10.9).

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-flow-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TASK = "task-700";
const key = (role: string) => `agent:main:swarm:${TASK}:${role}`;
const UPSTREAM = "agent:main:upstream-0000";

const CONTRACT = `id: ${TASK}
kind: build
input: add a function plus unit test
done_when: unit test passes
workers:
  build: { model: provider-a/model-a, thinking: "off" }
  audit: { model: provider-a/model-a, thinking: "off" }
  test: { model: provider-a/model-a, thinking: "off" }
upstream: { sessionKey: ${UPSTREAM} }
`;

type Script = (
  role: string,
  message: string,
) => { event: string; sha: string; body?: string } | null;

/**
 * Plays every live run in order: the "agent" emits per script, then the gateway reports the
 * run settled (the only run-end signal, ARCH §5).
 */
async function drive(
  engine: SwarmEngine,
  runtime: ReturnType<typeof makeStubRuntime>,
  script: Script,
) {
  createSwarmHooks(() => engine).attach(engine);
  let handled = 0;
  for (let guard = 0; guard < 50 && handled < runtime.runs.length; guard += 1) {
    const run = runtime.runs[handled++]!;
    if (!run.sessionKey.includes(":swarm:")) {
      continue;
    }
    const action = script(run.sessionKey.split(":").pop()!, run.message);
    if (action) {
      await createSwarmEmitTool({
        engine,
        callerSessionKey: run.sessionKey,
      }).execute("c", {
        body: "",
        ...action,
      });
    }
    await runtime.end(run.sessionKey);
  }
}

function setup() {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = makeStubRuntime();
  return { stateDir, runtime, engine: new SwarmEngine({ stateDir, runtime }) };
}

describe("swarm end-to-end flow (scripted agents)", () => {
  it("build → audit → test → DONE with no operator messages; upstream receives DONE", async () => {
    const { stateDir, runtime, engine } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    await drive(engine, runtime, (role, msg) => {
      if (role === "build" && msg.includes("TASK_STARTED"))
        return { event: "BUILD_DONE", sha: "c0ffee1" };
      if (role === "audit") return { event: "AUDIT_PASS", sha: "c0ffee1" };
      if (role === "test") return { event: "TEST_PASS", sha: "c0ffee1" };
      if (role === "taskmaster" && msg.includes("TEST_PASS"))
        return { event: "DONE", sha: "c0ffee1" };
      return null;
    });
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
    const upstream = runtime.runs.filter((r) => r.sessionKey === UPSTREAM);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.message).toContain("EVENT DONE @ c0ffee1");
    const emits = readEvents(stateDir, TASK)
      .filter((e) => e.kind === "emit")
      .map((e) => `${e.from}:${e.event}`);
    expect(emits).toEqual([
      "build:BUILD_DONE",
      "audit:AUDIT_PASS",
      "test:TEST_PASS",
      "taskmaster:DONE",
    ]);
  });

  it("an audit FAIL bounces to build, the fix is re-audited and the flow reaches DONE", async () => {
    const { stateDir, runtime, engine } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    let audits = 0;
    await drive(engine, runtime, (role, msg) => {
      if (role === "build" && msg.includes("TASK_STARTED"))
        return { event: "BUILD_DONE", sha: "aaa0001" };
      if (role === "build" && msg.includes("AUDIT_FAIL"))
        return { event: "BUILD_DONE", sha: "aaa0002" };
      if (role === "audit") {
        audits += 1;
        return audits === 1
          ? { event: "AUDIT_FAIL", sha: "aaa0001", body: "missing edge case" }
          : { event: "AUDIT_PASS", sha: "aaa0002" };
      }
      if (role === "test") return { event: "TEST_PASS", sha: "aaa0002" };
      if (role === "taskmaster" && msg.includes("TEST_PASS"))
        return { event: "DONE", sha: "aaa0002" };
      return null;
    });
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
    const emits = readEvents(stateDir, TASK)
      .filter((e) => e.kind === "emit")
      .map((e) => `${e.from}:${e.event}@${e.sha}`);
    expect(emits).toEqual([
      "build:BUILD_DONE@aaa0001",
      "audit:AUDIT_FAIL@aaa0001",
      "build:BUILD_DONE@aaa0002",
      "audit:AUDIT_PASS@aaa0002",
      "test:TEST_PASS@aaa0002",
      "taskmaster:DONE@aaa0002",
    ]);
  });

  it("a worker that stops without emitting gets the taskmaster re-prompt, then finishes", async () => {
    const { stateDir, runtime, engine } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    let buildTurns = 0;
    await drive(engine, runtime, (role, msg) => {
      if (role === "build") {
        buildTurns += 1;
        return buildTurns === 1 ? null : { event: "BUILD_DONE", sha: "bbb0001" };
      }
      if (role === "taskmaster" && msg.includes("ended without exit")) {
        return {
          event: "RETRY",
          sha: "init",
          role: "build",
          body: "you ended without emitting",
        } as never;
      }
      if (role === "audit") return { event: "AUDIT_PASS", sha: "bbb0001" };
      if (role === "test") return { event: "TEST_PASS", sha: "bbb0001" };
      if (role === "taskmaster" && msg.includes("TEST_PASS"))
        return { event: "DONE", sha: "bbb0001" };
      return null;
    });
    const events = readEvents(stateDir, TASK);
    expect(events.some((e) => e.event === "WORKER_EXIT_WITHOUT_EMIT" && e.from === "build")).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "emit" && e.event === "RETRY" && e.to === "build")).toBe(
      true,
    );
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
  });

  it("a gateway restart mid-task (audit run lost) resumes and finishes with no human action", async () => {
    const { stateDir, runtime, engine } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    // First gateway lifetime: build finishes, audit receives work, then the gateway dies.
    await drive(engine, runtime, (role, msg) =>
      role === "build" && msg.includes("TASK_STARTED")
        ? { event: "BUILD_DONE", sha: "ddd0001" }
        : null,
    );
    // Second lifetime: fresh engine + runtime, resume runs on service start.
    const runtime2 = makeStubRuntime();
    const engine2 = new SwarmEngine({ stateDir, runtime: runtime2 });
    const summary = await resumeOpenTasks(engine2);
    expect(summary.redelivered).toBeGreaterThanOrEqual(1);
    await drive(engine2, runtime2, (role, msg) => {
      if (role === "audit") return { event: "AUDIT_PASS", sha: "ddd0001" };
      if (role === "test") return { event: "TEST_PASS", sha: "ddd0001" };
      if (role === "taskmaster" && msg.includes("TEST_PASS"))
        return { event: "DONE", sha: "ddd0001" };
      return null;
    });
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
    expect(runtime2.runs.filter((r) => r.sessionKey === UPSTREAM)).toHaveLength(1);
  });

  it("killed twice in a row on the same input, then restarted, it still finishes (ARCH §10.4)", async () => {
    const { stateDir, runtime, engine } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    await drive(engine, runtime, (role, msg) =>
      role === "build" && msg.includes("TASK_STARTED")
        ? { event: "BUILD_DONE", sha: "eee0001" }
        : null,
    );
    // Two lifetimes die mid-audit: each gets the input again, neither answers.
    for (let kill = 0; kill < 2; kill += 1) {
      const rt = makeStubRuntime();
      await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: rt }));
      // audit (BUILD_DONE) and the taskmaster (its kickoff) both have unanswered inputs.
      const audit = rt.runs.filter((r) => r.sessionKey === key("audit"));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.message.match(/gateway restarted/g)).toHaveLength(1);
    }
    const runtime3 = makeStubRuntime();
    const engine3 = new SwarmEngine({ stateDir, runtime: runtime3 });
    await resumeOpenTasks(engine3);
    await drive(engine3, runtime3, (role, msg) => {
      if (role === "audit") return { event: "AUDIT_PASS", sha: "eee0001" };
      if (role === "test") return { event: "TEST_PASS", sha: "eee0001" };
      if (role === "taskmaster" && msg.includes("TEST_PASS"))
        return { event: "DONE", sha: "eee0001" };
      return null;
    });
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
  });

  it("ARCH §10.9: swarm answer reaches the taskmaster and is logged as OPERATOR", async () => {
    const { stateDir, runtime, engine } = setup();
    await startTask(engine, { contractYaml: CONTRACT });
    const res = await answerTask(engine, TASK, "use option B");
    expect(res).toMatchObject({ id: TASK });
    const op = readEvents(stateDir, TASK).find((e) => e.event === "OPERATOR");
    expect(op).toMatchObject({
      kind: "system",
      from: "operator",
      to: "taskmaster",
    });
    expect(op?.body).toBe("use option B");
    // The taskmaster's kickoff run is still live: the answer queues behind it (ARCH §5).
    expect(res.delivery).toBe("queued");
    await runtime.end(key("taskmaster"));
    const tm = runtime.runs.filter((r) => r.sessionKey === key("taskmaster"));
    expect(tm.at(-1)?.message).toContain("EVENT OPERATOR");
    expect(tm.at(-1)?.message).toContain("use option B");
    expect(runtime.maxLive.get(key("taskmaster"))).toBe(1);
  });
});
