import { describe, expect, it } from "vitest";
import { DEFAULT_BUILD_ROUTES, resolveRoute } from "./routing.js";

describe("swarm routing table (default build template)", () => {
  it("routes BUILD_DONE from build to audit", () => {
    const route = resolveRoute(DEFAULT_BUILD_ROUTES, { event: "BUILD_DONE", from: "build" });
    expect(route?.to).toBe("audit");
  });

  it("routes AUDIT_FAIL back to build with findings", () => {
    const route = resolveRoute(DEFAULT_BUILD_ROUTES, { event: "AUDIT_FAIL", from: "audit" });
    expect(route?.to).toBe("build");
  });

  it("routes AUDIT_PASS from audit to test", () => {
    const route = resolveRoute(DEFAULT_BUILD_ROUTES, { event: "AUDIT_PASS", from: "audit" });
    expect(route?.to).toBe("test");
  });

  it("routes TEST_FAIL back to build with repro", () => {
    const route = resolveRoute(DEFAULT_BUILD_ROUTES, { event: "TEST_FAIL", from: "test" });
    expect(route?.to).toBe("build");
  });

  it("routes TEST_PASS from test to taskmaster", () => {
    const route = resolveRoute(DEFAULT_BUILD_ROUTES, { event: "TEST_PASS", from: "test" });
    expect(route?.to).toBe("taskmaster");
  });

  it("routes DONE from taskmaster to upstream", () => {
    const route = resolveRoute(DEFAULT_BUILD_ROUTES, { event: "DONE", from: "taskmaster" });
    expect(route?.to).toBe("upstream");
  });

  it("routes BLOCKED from any worker to taskmaster", () => {
    for (const from of ["build", "audit", "test"]) {
      const route = resolveRoute(DEFAULT_BUILD_ROUTES, { event: "BLOCKED", from });
      expect(route?.to).toBe("taskmaster");
    }
  });

  it("returns null for an unrouted (event, from) pair", () => {
    expect(resolveRoute(DEFAULT_BUILD_ROUTES, { event: "AUDIT_PASS", from: "build" })).toBeNull();
    expect(resolveRoute(DEFAULT_BUILD_ROUTES, { event: "NOT_A_THING", from: "build" })).toBeNull();
  });

  it("never fans out: every route has exactly one target in the MVP", () => {
    for (const row of DEFAULT_BUILD_ROUTES) {
      expect(typeof row.to).toBe("string");
      expect(row.count ?? 1).toBe(1);
      expect(row.join ?? 1).toBe(1);
    }
  });

  it("message templates support a {{sha}} placeholder", () => {
    const route = resolveRoute(DEFAULT_BUILD_ROUTES, { event: "BUILD_DONE", from: "build" });
    expect(route?.message).toMatch(/\{\{?sha\}?\}/);
  });
});
