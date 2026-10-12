import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SwarmContractError, taskDirFor } from "./contract.js";
import { holonStateFrom, loadHolon, parseHolon, parseJoin, targetMembers } from "./holon.js";
import { seedTask } from "./test-fixtures.js";

// ARCH §2 holon file, §3.1-3.2 lead, §11 v1-as-root-holon, §4 lane fields.

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-holon-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const V2 = `
id: website-acme
goal: build the site
done_when: the site builds and its tests pass
lead: { kind: agent, model: provider-lead/model-lead, thinking: high }
lanes:
  build: { count: 3, model: provider-a/model-a, thinking: "off", partition: true }
  audit: { count: 5, model: [provider-a/model-a, provider-b/model-b], thinking: high, join: "quorum:4" }
  test: { count: 1, model: provider-a/model-a, thinking: "off" }
children: []
canon:
  scope: the repo
  never: [push, merge, deploy]
  approve: [plan]
  depth: 3
repo: /tmp/swarm-holon-repo
`;

describe("holon file (ARCH §2)", () => {
  it("parses a v2 holon: goal, lead, lanes, canon, children", () => {
    const holon = parseHolon(V2);
    expect(holon.contract.id).toBe("website-acme");
    expect(holon.contract.input).toBe("build the site");
    expect(holon.contract.done_when).toBe("the site builds and its tests pass");
    expect(holon.lead).toEqual({
      kind: "agent",
      model: "provider-lead/model-lead",
      thinking: "high",
    });
    expect(holon.children).toEqual([]);
    expect(holon.canon).toEqual({
      scope: "the repo",
      never: ["push", "merge", "deploy"],
      approve: ["plan"],
      depth: 3,
    });
    expect(holon.v1).toBe(false);
  });

  it("lanes carry count, model cycle, partition and join (ARCH §4)", () => {
    const holon = parseHolon(V2);
    const [build, audit, test] = holon.lanes;
    expect(build).toMatchObject({ role: "build", count: 3, partition: true });
    expect(build.models).toEqual(["provider-a/model-a"]);
    expect(audit.count).toBe(5);
    expect(audit.models).toEqual(["provider-a/model-a", "provider-b/model-b"]);
    expect(audit.join).toEqual({ kind: "quorum", k: 4 });
    expect(test.join).toEqual({ kind: "all" });
  });

  it("lead defaults to an agent on the gateway default model (§3.1)", () => {
    const holon = parseHolon(V2.replace(/^lead:.*\n/m, ""));
    expect(holon.lead).toEqual({ kind: "agent" });
  });

  it("a human lead parses as a later build step, refused for now (§3.3)", () => {
    expect(() =>
      parseHolon(
        V2.replace("kind: agent, model: provider-lead/model-lead", "kind: human, channel: chat"),
      ),
    ).toThrow(SwarmContractError);
  });

  it("rejects both lanes and workers, a quorum above the count, and unknown lane fields", () => {
    expect(() => parseHolon(`${V2}workers:\n  build: {}\n`)).toThrow(/both lanes and workers/);
    expect(() => parseHolon(V2.replace('join: "quorum:4"', 'join: "quorum:9"'))).toThrow(
      /count >= 9/,
    );
    expect(() => parseHolon(V2.replace("partition: true", "bogus: true"))).toThrow(
      /not a known lane field/,
    );
  });

  it("join accepts all | any | quorum:<k> and nothing else", () => {
    expect(parseJoin(undefined, "x")).toEqual({ kind: "all" });
    expect(parseJoin("any", "x")).toEqual({ kind: "any" });
    expect(parseJoin("quorum:3", "x")).toEqual({ kind: "quorum", k: 3 });
    expect(() => parseJoin("majority", "x")).toThrow(/not a join/);
    expect(() => parseJoin("quorum:0", "x")).toThrow(/not a join|k >= 1/);
  });

  it("a template route to an undeclared lane remaps to the lead; from-rows drop (no dead sessions)", () => {
    const holon = parseHolon(`
id: two-lane
goal: x
done_when: y
lanes:
  build: { count: 1, model: provider-a/model-a }
  test: { count: 1, model: provider-a/model-a }
`);
    // No audit lane: audit's own rows drop; build's BUILD_DONE (template: to audit) remaps
    // to the lead, which drives the next hop itself (§4.5).
    expect(holon.contract.routes.some((r) => r.from === "audit")).toBe(false);
    const buildDone = holon.contract.routes.find(
      (r) => r.on === "BUILD_DONE" && r.from === "build",
    );
    expect(buildDone?.to).toBe("taskmaster");
    expect(holon.contract.routes.some((r) => r.on === "TEST_PASS" && r.to === "taskmaster")).toBe(
      true,
    );
    expect(holon.contract.routes.some((r) => r.on === "BLOCKED")).toBe(true);
  });

  it("explicit routes stay verbatim, validated against the lanes", () => {
    const holon = parseHolon(`
id: explicit-routes
goal: x
done_when: y
lanes:
  build: { count: 1, model: provider-a/model-a }
routes:
  - { on: BUILD_DONE, from: build, to: taskmaster, message: "x" }
  - { on: DONE, from: taskmaster, to: upstream, message: "done" }
`);
    expect(holon.contract.routes).toHaveLength(2);
    // An explicit route to an undeclared lane is an author error, refused at parse (as v1).
    expect(() =>
      parseHolon(`
id: explicit-bad
goal: x
done_when: y
lanes:
  build: { count: 1, model: provider-a/model-a }
routes:
  - { on: BUILD_DONE, from: build, to: nowhere, message: "x" }
`),
    ).toThrow(/not a declared role/);
  });
});

describe("v1 contract as a root holon (ARCH §11)", () => {
  it("loads contract.yaml as one lane per role, lead on the default model", () => {
    const stateDir = path.join(tmp, "v1");
    seedTask(stateDir, { taskId: "task-v1", headSha: "abc123" });
    const holon = loadHolon(stateDir, "task-v1");
    expect(holon.v1).toBe(true);
    expect(holon.lead).toEqual({ kind: "agent" });
    expect(holon.lanes.map((l) => `${l.role}:${l.count}`).toSorted()).toEqual([
      "audit:1",
      "build:1",
      "test:1",
    ]);
    expect(holon.lanes.every((l) => l.join.kind === "all" && !l.partition)).toBe(true);
    // The lane roles are the contract workers, so v1 routing is unchanged.
    expect(Object.keys(holon.contract.workers).toSorted()).toEqual(["audit", "build", "test"]);
  });

  it("holon.yaml wins over contract.yaml in the same folder", () => {
    const stateDir = path.join(tmp, "v2");
    const dir = taskDirFor(stateDir, "task-v2");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "holon.yaml"), V2.replace("website-acme", "task-v2"));
    const holon = loadHolon(stateDir, "task-v2");
    expect(holon.v1).toBe(false);
    expect(holon.lanes.find((l) => l.role === "audit")?.count).toBe(5);
  });

  it("a count-1 lane keeps the bare role as its member; count > 1 fans out to <role>:<n>", () => {
    const holon = parseHolon(V2);
    expect(targetMembers(holon, "build")).toEqual(["build:1", "build:2", "build:3"]);
    expect(targetMembers(holon, "test")).toEqual(["test"]);
    expect(targetMembers(holon, "taskmaster")).toEqual(["taskmaster"]);
  });
});

describe("derived state (ARCH §2: the log is the state)", () => {
  const ev = (event: string, extra: Record<string, unknown> = {}) => ({
    kind: "system",
    event,
    ...extra,
  });
  it("planning → running → blocked/done/failed/cancelled", () => {
    expect(holonStateFrom([])).toBe("planning");
    expect(holonStateFrom([ev("TASK_STARTED", { to: "build" })])).toBe("running");
    expect(
      holonStateFrom([
        ev("TASK_STARTED", { to: "build" }),
        { kind: "upstream", event: "DONE", to: "upstream" },
      ]),
    ).toBe("done");
    expect(
      holonStateFrom([
        ev("TASK_STARTED", { to: "build" }),
        { kind: "upstream", event: "BLOCKED", to: "upstream" },
      ]),
    ).toBe("blocked");
    expect(
      holonStateFrom([
        ev("TASK_STARTED", { to: "build" }),
        ev("TASK_CLOSED", { data: { status: "failed" } }),
      ]),
    ).toBe("failed");
    expect(
      holonStateFrom([
        ev("TASK_STARTED", { to: "build" }),
        ev("TASK_CLOSED", { data: { status: "cancelled" } }),
      ]),
    ).toBe("cancelled");
  });
});
