import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test-utils/plugin-api.js";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import register from "../index.js";
import {
  callerCwd,
  formatCliError,
  formatDuration,
  registerSwarmCli,
  resolveContractPath,
} from "./cli.js";
import { SwarmEngine } from "./engine.js";
import { createSwarmMethods } from "./methods.js";
import { makeStubRuntime } from "./test-runtime.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-plugin-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CONTRACT = `id: task-600
kind: build
input: x
done_when: y
workers:
  build: { model: provider-a/model-a }
  audit: {}
  test: {}
`;

async function callMethod(
  handlers: ReturnType<typeof createSwarmMethods>,
  method: string,
  params: Record<string, unknown>,
) {
  let out:
    | {
        ok: boolean;
        payload: unknown;
        error?: { code: string; message: string };
      }
    | undefined;
  await handlers[method]!({
    params,
    respond: (ok: boolean, payload: unknown, error?: { code: string; message: string }) => {
      out = { ok, payload, error };
    },
  } as never);
  return out!;
}

describe("swarm gateway methods", () => {
  it("start, list, show, answer and cancel round-trip through the engine", async () => {
    const stateDir = path.join(tmp, "methods");
    fs.mkdirSync(stateDir, { recursive: true });
    const engine = new SwarmEngine({ stateDir, runtime: makeStubRuntime() });
    const handlers = createSwarmMethods(() => engine);
    expect(Object.keys(handlers).toSorted()).toEqual([
      "swarm.answer",
      "swarm.cancel",
      "swarm.list",
      "swarm.show",
      "swarm.start",
    ]);

    const started = await callMethod(handlers, "swarm.start", { contract: CONTRACT });
    expect(started).toMatchObject({ ok: true, payload: { id: "task-600", taskId: "task-600" } });
    const listed = await callMethod(handlers, "swarm.list", {});
    expect((listed.payload as { tasks: Array<{ id: string }> }).tasks[0]?.id).toBe("task-600");
    const shown = await callMethod(handlers, "swarm.show", { taskId: "task-600", limit: 1 });
    expect((shown.payload as { events: unknown[] }).events).toHaveLength(1);
    const answered = await callMethod(handlers, "swarm.answer", {
      taskId: "task-600",
      message: "go ahead",
    });
    expect(answered).toMatchObject({ ok: true, payload: { id: "task-600" } });
    expect((await callMethod(handlers, "swarm.answer", { taskId: "task-600" })).ok).toBe(false);
    const cancelled = await callMethod(handlers, "swarm.cancel", {
      taskId: "task-600",
    });
    expect(cancelled.payload).toMatchObject({ status: "cancelled" });
  });

  it("puts the error text where gateway clients read it, not only in the payload", async () => {
    const stateDir = path.join(tmp, "errshape");
    fs.mkdirSync(stateDir, { recursive: true });
    const engine = new SwarmEngine({ stateDir, runtime: makeStubRuntime() });
    const handlers = createSwarmMethods(() => engine);
    await callMethod(handlers, "swarm.start", { contract: CONTRACT });
    const dup = await callMethod(handlers, "swarm.start", { contract: CONTRACT });
    expect(dup.ok).toBe(false);
    expect(dup.error).toEqual({
      code: "INVALID_REQUEST",
      message: 'task "task-600" already exists',
    });
    expect(dup.payload).toEqual({ error: 'task "task-600" already exists' });
    const off = await callMethod(
      createSwarmMethods(() => undefined),
      "swarm.list",
      {},
    );
    expect(off.error).toEqual({ code: "UNAVAILABLE", message: "swarm plugin is not started" });
  });

  it("refuses a relative contract path instead of resolving it in the gateway cwd (change 2)", async () => {
    const engine = new SwarmEngine({ stateDir: path.join(tmp, "rel"), runtime: makeStubRuntime() });
    const res = await callMethod(
      createSwarmMethods(() => engine),
      "swarm.start",
      {
        file: "c.yaml",
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message).toMatch(/must be an absolute path/);
  });

  it("reports errors without throwing", async () => {
    const engine = new SwarmEngine({ stateDir: path.join(tmp, "err"), runtime: makeStubRuntime() });
    const handlers = createSwarmMethods(() => engine);
    expect(await callMethod(handlers, "swarm.start", {})).toMatchObject({ ok: false });
    expect(await callMethod(handlers, "swarm.show", { taskId: "task-none" })).toMatchObject({
      ok: false,
    });
    expect(
      await callMethod(
        createSwarmMethods(() => undefined),
        "swarm.list",
        {},
      ),
    ).toMatchObject({
      ok: false,
      payload: { error: "swarm plugin is not started" },
    });
  });
});

describe("swarm CLI", () => {
  function run(argv: string[], reply: unknown, opts: { cwd?: string; reject?: Error } = {}) {
    const program = new Command().exitOverride();
    const lines: string[] = [];
    const errors: string[] = [];
    let failed = 0;
    const call = vi.fn(async () => {
      if (opts.reject) {
        throw opts.reject;
      }
      return reply;
    });
    registerSwarmCli({
      program,
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      fail: () => {
        failed += 1;
      },
      call,
      ...(opts.cwd && { cwd: () => opts.cwd! }),
    });
    return program
      .parseAsync(["node", "openclaw", "swarm", ...argv])
      .then(() => ({ lines, errors, failed, call }));
  }

  it("every read supports --json", async () => {
    const tasks = [{ id: "task-1", status: "open", sha: "abc", ageMs: 0 }];
    const { lines } = await run(["list", "--json"], { tasks });
    expect(JSON.parse(lines.join("\n"))).toEqual(tasks);
    const shown = { id: "task-1", status: "open", sha: "abc", models: {}, events: [] };
    const res = await run(["show", "task-1", "--json"], shown);
    expect(JSON.parse(res.lines.join("\n"))).toEqual(shown);
  });

  const STARTED = { taskId: "task-1", id: "task-1", sha: "init", sessions: {}, workers: {} };

  it("start resolves a relative --file against the caller's cwd, not the process cwd (change 2)", async () => {
    const callerDir = path.join(tmp, "caller", "sub");
    const { call } = await run(["start", "--file", "../c.yaml"], STARTED, { cwd: callerDir });
    expect(call).toHaveBeenCalledWith("swarm.start", expect.anything(), {
      file: path.join(tmp, "caller", "c.yaml"),
    });
    const abs = await run(["start", "--file", "/abs/c.yaml"], STARTED, { cwd: callerDir });
    expect(abs.call).toHaveBeenCalledWith("swarm.start", expect.anything(), {
      file: "/abs/c.yaml",
    });
  });

  it("caller cwd prefers the package-manager launch dir (INIT_CWD) when set (change 2)", () => {
    expect(callerCwd({ INIT_CWD: "/caller/dir" }, "/repo/root")).toBe("/caller/dir");
    expect(callerCwd({}, "/caller/dir")).toBe("/caller/dir");
    expect(callerCwd({ INIT_CWD: "relative" }, "/caller/dir")).toBe("/caller/dir");
    expect(resolveContractPath("t.yaml", "/caller/dir")).toBe("/caller/dir/t.yaml");
  });

  it("start prints and returns the taskId (change 3)", async () => {
    const human = await run(["start", "--file", "c.yaml"], STARTED, { cwd: tmp });
    expect(human.lines[0]).toBe("started task-1 @ init");
    const json = await run(["start", "--file", "c.yaml", "--json"], STARTED, { cwd: tmp });
    expect(JSON.parse(json.lines.join("\n"))).toMatchObject({ taskId: "task-1" });
  });

  it("a gateway error prints one clean line and fails, no stack (change 4)", async () => {
    const err = new Error("ENOENT: no such file or directory, open '/x/c.yaml'");
    for (const argv of [
      ["start", "--file", "c.yaml"],
      ["list"],
      ["show", "task-1"],
      ["cancel", "task-1"],
    ]) {
      const res = await run(argv, undefined, { reject: err, cwd: tmp });
      expect(res.errors).toEqual(["swarm: ENOENT: no such file or directory, open '/x/c.yaml'"]);
      expect(res.failed).toBe(1);
      expect(res.lines).toEqual([]);
    }
    const multi = await run(["list"], undefined, { reject: new Error("first\nsecond") });
    expect(multi.errors).toEqual(["swarm: first"]);
  });

  it("--verbose keeps the stack (change 4)", async () => {
    const res = await run(["show", "task-1", "--verbose"], undefined, {
      reject: new Error("task not found"),
    });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/^swarm: Error: task not found\n\s+at /);
    expect(res.failed).toBe(1);
    expect(formatCliError("plain")).toBe("swarm: plain");
  });

  it("show prints the handover table, duration and active time (change 5)", async () => {
    const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const shown = {
      id: "task-1",
      status: "done",
      sha: "abc",
      models: {},
      events: [],
      startedAt: T0,
      endedAt: T0 + 125_000,
      durationMs: 125_000,
      handovers: [
        {
          seq: 5,
          ts: T0,
          event: "TASK_STARTED",
          from: "taskmaster",
          to: "build",
          sha: "abc",
          sinceStartMs: 0,
          sincePrevMs: 0,
        },
        {
          seq: 9,
          ts: T0 + 65_000,
          event: "BUILD_DONE",
          from: "build",
          to: "audit",
          sha: "def",
          sinceStartMs: 65_000,
          sincePrevMs: 65_000,
        },
      ],
      activeMs: { build: 64_000 },
    };
    const { lines } = await run(["show", "task-1"], shown);
    const table = lines.slice(lines.findIndex((l) => l.startsWith("handovers")));
    expect(table[0]).toBe(
      "handovers  started 2026-01-01T10:00:00Z  ended 2026-01-01T10:02:05Z  duration 2m05s",
    );
    expect(table[2]).toMatch(
      /^\s+5 10:00:00\s+0ms\s+0ms TASK_STARTED\s+taskmaster -> build\s+abc$/,
    );
    expect(table[3]).toMatch(/^\s+9 10:01:05\s+1m05s\s+1m05s BUILD_DONE\s+build -> audit\s+def$/);
    expect(table[4]).toBe("  active: build=1m04s");
    const json = await run(["show", "task-1", "--json"], shown);
    expect(JSON.parse(json.lines.join("\n")).handovers).toHaveLength(2);
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(7_200_000 + 180_000)).toBe("2h03m");
  });

  it("cancel passes the task id and reason", async () => {
    const { call, lines } = await run(["cancel", "task-1", "--reason", "stop"], {
      status: "cancelled",
      changed: true,
    });
    expect(call).toHaveBeenCalledWith("swarm.cancel", expect.anything(), {
      taskId: "task-1",
      reason: "stop",
    });
    expect(lines).toEqual(["task-1: cancelled"]);
  });

  it("answer sends the task id and message to swarm.answer (ARCH §5, §9)", async () => {
    const { call, lines } = await run(["answer", "task-1", "use option B"], {
      seq: 12,
      delivery: "queued",
    });
    expect(call).toHaveBeenCalledWith("swarm.answer", expect.anything(), {
      taskId: "task-1",
      message: "use option B",
    });
    expect(lines).toEqual(["task-1: OPERATOR seq 12 to taskmaster (queued)"]);
  });
});

describe("swarm plugin registration", () => {
  it("registers the tool, the model hook, five methods, the CLI and the service", () => {
    const tools: Array<{ opts?: { name?: string } }> = [];
    const hooks: string[] = [];
    const methods: string[] = [];
    const services: string[] = [];
    const cli: Array<{ commands?: string[] }> = [];
    register(
      createTestPluginApi({
        id: "swarm",
        name: "Swarm",
        source: "test",
        config: {},
        runtime: createPluginRuntimeMock(),
        registerTool: (_tool, opts) => tools.push({ opts }),
        on: (name) => hooks.push(name),
        registerGatewayMethod: (name) => methods.push(name),
        registerService: (svc) => services.push(svc.id),
        registerCli: (_r, opts) => cli.push(opts ?? {}),
      }),
    );
    expect(tools).toEqual([{ opts: { name: "swarm_emit" } }]);
    expect(hooks).toEqual(["llm_input"]);
    expect(methods.toSorted()).toEqual([
      "swarm.answer",
      "swarm.cancel",
      "swarm.list",
      "swarm.show",
      "swarm.start",
    ]);
    expect(services).toEqual(["swarm"]);
    expect(cli).toEqual([{ commands: ["swarm"] }]);
  });

  it("service start resumes from <stateDir>/swarm and stop clears state", async () => {
    let service:
      | {
          start: (ctx: never) => Promise<void> | void;
          stop?: (ctx: never) => unknown;
        }
      | undefined;
    const runtime = createPluginRuntimeMock();
    register(
      createTestPluginApi({
        id: "swarm",
        name: "Swarm",
        source: "test",
        config: {},
        runtime,
        registerService: (svc) => {
          service = svc;
        },
      }),
    );
    const stateDir = path.join(tmp, "svc");
    await service!.start({
      stateDir,
      config: {},
      logger: { info() {}, warn() {}, error() {} },
    } as never);
    await service!.stop?.({} as never);
    expect(runtime.subagent.run).not.toHaveBeenCalled();
  });
});
