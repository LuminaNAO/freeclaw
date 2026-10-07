import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadContract, parseContract, SwarmContractError } from "./contract.js";
import { DEFAULT_BUILD_ROUTES } from "./routing.js";

const tmp = mkdtempSync(path.join(tmpdir(), "swarm-contract-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function validContractYaml(overrides = ""): string {
  return `
id: task-0001
kind: build
input: add a function plus unit test
done_when: unit test passes on the head commit
workers:
  build: { count: 1, model: cb-sonnet/claude-sonnet-5-5, thinking: "off" }
  audit: { count: 1, model: cb-sonnet/claude-sonnet-5-5, thinking: "off" }
  test: { count: 1, model: cb-sonnet/claude-sonnet-5-5, thinking: "off" }
upstream:
  sessionKey: agent:main:swarm-upstream
  events: [DONE, BLOCKED, FAILED]
budget: { wall: 4h, step_silence: 30m }
repo: ${tmp}
${overrides}
`;
}

describe("swarm contract parsing", () => {
  it("parses a valid contract and fills defaults", () => {
    const contract = parseContract(validContractYaml());
    expect(contract.id).toBe("task-0001");
    expect(contract.kind).toBe("build");
    expect(Object.keys(contract.workers).sort()).toEqual(["audit", "build", "test"]);
    expect(contract.workers.build.count).toBe(1);
    // budget.step_silence is accepted in old contracts and ignored (ARCH §7).
    expect(contract.budget).toEqual({ wall: "4h" });
    // No routes in the YAML: template default applies.
    expect(contract.routes).toEqual(DEFAULT_BUILD_ROUTES);
  });

  it("accepts a per-task routes override", () => {
    const yaml = validContractYaml(`routes:
  - { on: BUILD_DONE, from: build, to: audit, message: "review {sha}" }
  - { on: AUDIT_PASS, from: audit, to: test, message: "test {sha}" }
  - { on: TEST_PASS, from: test, to: taskmaster, message: "gate passed {sha}" }
`);
    const contract = parseContract(yaml);
    expect(contract.routes).not.toEqual(DEFAULT_BUILD_ROUTES);
    expect(contract.routes).toHaveLength(3);
    expect(contract.routes[0]).toMatchObject({ on: "BUILD_DONE", from: "build", to: "audit" });
  });

  it.each([
    ["missing id", `kind: build\ninput: x\ndone_when: y\nworkers: {}\n`],
    ["missing done_when", `id: t1\nkind: build\ninput: x\nworkers:\n  build: { count: 1 }\n`],
    ["empty workers", `id: t1\nkind: build\ninput: x\ndone_when: y\nworkers: {}\n`],
  ])("rejects a contract with %s", (_label, yaml) => {
    expect(() => parseContract(yaml)).toThrow(SwarmContractError);
  });

  it("rejects count > 1 (fan-out is reserved for later)", () => {
    const yaml = validContractYaml().replace("build: { count: 1,", "build: { count: 2,");
    expect(() => parseContract(yaml)).toThrow(SwarmContractError);
  });

  it.each([["all"], ["quorum-2"], ["any"]])(
    "rejects join: %s (join is reserved for later)",
    (join) => {
      const yaml = validContractYaml().replace(
        "audit: { count: 1,",
        `audit: { count: 1, join: ${JSON.stringify(join)},`,
      );
      expect(() => parseContract(yaml)).toThrow(SwarmContractError);
    },
  );

  it("rejects unknown worker fields", () => {
    const yaml = validContractYaml().replace(
      "test: { count: 1,",
      "test: { count: 1, bogus_field: true,",
    );
    expect(() => parseContract(yaml)).toThrow(SwarmContractError);
  });

  it("rejects a route whose from/to is not a known worker, taskmaster, or upstream", () => {
    const yaml = validContractYaml(`routes:
  - { on: BUILD_DONE, from: build, to: nobody, message: "x" }
`);
    expect(() => parseContract(yaml)).toThrow(SwarmContractError);
  });

  it("rejects a contract id with path traversal", () => {
    const yaml = validContractYaml().replace("id: task-0001", "id: ../escape");
    expect(() => parseContract(yaml)).toThrow(SwarmContractError);
  });

  it("loads a contract from <stateDir>/swarm/<task-id>/contract.yaml", () => {
    const taskDir = path.join(tmp, "state", "swarm", "task-0002");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      path.join(taskDir, "contract.yaml"),
      validContractYaml().replace("task-0001", "task-0002"),
    );
    const contract = loadContract(path.join(tmp, "state"), "task-0002");
    expect(contract.id).toBe("task-0002");
  });

  it("loadContract fails for a missing task", () => {
    expect(() => loadContract(path.join(tmp, "state"), "task-does-not-exist")).toThrow(
      SwarmContractError,
    );
  });
});
