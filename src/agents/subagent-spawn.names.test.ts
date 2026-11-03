import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => hoisted.configOverride };
});

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: () => "",
  getOAuthProviders: () => [],
}));

vi.mock("./subagent-registry.js", () => ({
  countActiveRunsForSession: () => 0,
  registerSubagentRun: () => {},
}));

vi.mock("./subagent-announce.js", () => ({
  buildSubagentSystemPrompt: () => "system-prompt",
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("./model-selection.js", () => ({
  resolveSubagentSpawnModelSelection: () => undefined,
}));

vi.mock("./sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

let tmpDir = "";
let storePath = "";

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(storePath, JSON.stringify(store));
}

function patchesFor(prefix: string) {
  return hoisted.callGatewayMock.mock.calls
    .map((call) => call[0] as { method?: string; params?: Record<string, unknown> })
    .filter((call) => call.method === "sessions.patch")
    .map((call) => call.params ?? {})
    .filter((params) => typeof params.key === "string" && params.key.startsWith(prefix));
}

function lineagePatch() {
  const patch = patchesFor("agent:main:subagent:").find((params) => "spawnedBy" in params);
  if (!patch) {
    throw new Error("no lineage patch was sent");
  }
  return patch;
}

async function spawn(params: { task: string; label?: string }, requesterKey = "agent:main:main") {
  const result = await spawnSubagentDirect(params, {
    agentSessionKey: requesterKey,
    agentChannel: "signal",
    agentTo: "group-1",
  });
  expect(result.status).toBe("accepted");
  return result;
}

describe("spawnSubagentDirect session names (ARCH subagent-session-names §1)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-names-"));
    storePath = path.join(tmpDir, "sessions.json");
    writeStore({});
    hoisted.configOverride = {
      session: { mainKey: "main", scope: "per-sender", store: storePath },
    };
    hoisted.callGatewayMock.mockReset();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes label and displayName in the same patch as spawnedBy when a label is given", async () => {
    writeStore({ "agent:main:main": { sessionId: "s1", updatedAt: 1, displayName: "Ops Room" } });
    await spawn({ task: "Audit the thing", label: "audit-pass" });
    const patch = lineagePatch();
    expect(patch.spawnedBy).toBe("agent:main:main");
    expect(patch.label).toBe("audit-pass");
    expect(patch.displayName).toBe("Ops Room › audit-pass");
  });

  it("makes a slug from the first task line when no label is given", async () => {
    writeStore({});
    await spawn({
      task: "\n  Review the Retry Logic, then summarise it for the team please\nmore",
    });
    const patch = lineagePatch();
    expect(patch.label).toBe("review-the-retry-logic-then-summarise");
    // The main session has no name of its own, so the child is named by its label alone.
    expect(patch.displayName).toBe("review-the-retry-logic-then-summarise");
  });

  it("trims the requester name to 24 chars", async () => {
    writeStore({
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        displayName: "A very long group subject that goes on",
      },
    });
    await spawn({ task: "x", label: "job" });
    const name = String(lineagePatch().displayName);
    const [requester, label] = name.split(" › ");
    expect(Array.from(requester ?? "").length).toBe(24);
    expect(label).toBe("job");
  });

  it("falls back to the group subject for the requester name", async () => {
    writeStore({ "agent:main:main": { sessionId: "s1", updatedAt: 1, subject: "Build Crew" } });
    await spawn({ task: "x", label: "job" });
    expect(lineagePatch().displayName).toBe("Build Crew › job");
  });

  it("chains a nested spawn once through the parent label", async () => {
    const parentKey = "agent:main:subagent:11111111-1111-4111-8111-111111111111";
    writeStore({
      [parentKey]: {
        sessionId: "s2",
        updatedAt: 1,
        spawnedBy: "agent:main:main",
        label: "parent-job",
        displayName: "Ops Room › parent-job",
      },
    });
    await spawn({ task: "x", label: "leaf-job" }, parentKey);
    const patch = lineagePatch();
    expect(patch.label).toBe("leaf-job");
    expect(patch.displayName).toBe("parent-job › leaf-job");
  });

  it("never puts a path, URL or uuid in a task-derived slug", async () => {
    await spawn({
      task: "Fix /srv/app/src/main.ts at https://example.com/x?id=1 for 5b6f3f0e-aaaa-4bbb-8ccc-0123456789ab now",
    });
    const label = String(lineagePatch().label);
    expect(label).toBe("fix-at-for-now");
    expect(label).not.toMatch(/\/|https?|[0-9a-f]{8}-[0-9a-f]{4}|\.ts/);
  });
});
