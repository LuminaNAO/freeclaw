import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SwarmEngine } from "./engine.js";
import { noGroupAdapter, resolveGroupAdapter, type SwarmGroupAdapter } from "./group.js";
import { readEvents, readTasksIndex } from "./store.js";
import { startTask } from "./tasks.js";
import { makeStubRuntime } from "./test-runtime.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-group-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CONTRACT = `id: task-800
kind: build
input: x
done_when: y
workers:
  build: {}
  audit: {}
  test: {}
`;

describe("group adapter (ARCH §1.5, §9)", () => {
  it("only the no-group adapter exists in the MVP", async () => {
    expect(resolveGroupAdapter(undefined).kind).toBe("none");
    expect(resolveGroupAdapter("none")).toBe(noGroupAdapter);
    expect(resolveGroupAdapter("something-else").kind).toBe("none");
    await expect(noGroupAdapter.ensureGroup("task-1")).resolves.toEqual({ ok: true });
  });

  it("start records the group outcome; a failing adapter never blocks the task", async () => {
    const stateDir = path.join(tmp, "fail");
    fs.mkdirSync(stateDir, { recursive: true });
    const failing: SwarmGroupAdapter = {
      kind: "test",
      ensureGroup: async () => {
        throw new Error("channel unavailable");
      },
      post: async () => {},
      dispose: async () => {
        throw new Error("channel unavailable");
      },
    };
    const runtime = makeStubRuntime();
    const engine = new SwarmEngine({ stateDir, runtime, group: failing });
    await startTask(engine, { contractYaml: CONTRACT });
    expect(readTasksIndex(stateDir)["task-800"]?.status).toBe("open");
    expect(readEvents(stateDir, "task-800").find((e) => e.event === "GROUP")?.data).toMatchObject({
      kind: "test",
      ok: false,
      reason: "channel unavailable",
    });
    expect(runtime.runs.length).toBeGreaterThan(0);
    expect(() => engine.close("task-800", "done")).not.toThrow();
  });
});
