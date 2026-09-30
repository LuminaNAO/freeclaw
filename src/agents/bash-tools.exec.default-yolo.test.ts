import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../config/config.js";

/**
 * Fresh installs get exec security="full", ask="off" (YOLO): onboarding WRITES those keys into
 * the config (applyOnboardingLocalWorkspaceConfig with freshInstall:true), and pi-tools feeds
 * tools.exec.security/ask into createExecTool. So a fresh install is observed here as a tool
 * created with explicit full/off — that is what the shipped config actually contains.
 *
 * These tests use a plain (non-obfuscated) command that still misses an allowlist, so they
 * isolate default-resolution from the obfuscation-detector removal.
 *
 * CONTESTED SPEC POINT (see exec-approvals.yolo-defaults.test.ts): what happens when a config
 * never set tools.exec at all. Build shipped the legacy fallback (allowlist/on-miss) for that
 * case rather than flipping it to YOLO at runtime, so an existing non-fresh config is not
 * silently loosened. The last test pins that shipped behavior and fails loudly if the
 * orchestrator picks the runtime-YOLO reading instead.
 */

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;

async function writeExecApprovalsConfig(config: Record<string, unknown>) {
  const approvalsPath = path.join(process.env.HOME ?? "", ".openclaw", "exec-approvals.json");
  await fs.mkdir(path.dirname(approvalsPath), { recursive: true });
  await fs.writeFile(approvalsPath, JSON.stringify(config, null, 2));
}

// A plain, non-obfuscated command that would still miss an allowlist.
const PLAIN_COMMAND = "npm view example-pkg version";

describe("runcap: fresh-install exec defaults run without approval (YOLO)", () => {
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ createExecTool } = await import("./bash-tools.exec.js"));
  });

  beforeEach(async () => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runcap-yolo-"));
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    vi.resetAllMocks();
    clearConfigCache();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  });

  async function runGatewayExec(defaults: Record<string, unknown>) {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      return { ok: true };
    });
    const tool = createExecTool({ host: "gateway", approvalRunningNoticeMs: 0, ...defaults });
    const result = await tool.execute("call-default", { command: PLAIN_COMMAND });
    return { calls, result };
  }

  it("runs an allowlist-miss command with no approval under fresh-install defaults", async () => {
    // This is the config a fresh install actually has: tools.exec seeded to full/off.
    const { calls, result } = await runGatewayExec({ security: "full", ask: "off" });

    expect(result.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("preserves an explicit allowlist/on-miss config (still asks on a miss)", async () => {
    // Existing stricter config must not be silently loosened to YOLO.
    const { calls, result } = await runGatewayExec({ security: "allowlist", ask: "on-miss" });

    expect(calls).toContain("exec.approval.request");
    expect(result.details.status).not.toBe("completed");
  });

  it("keeps an explicit ask=always gating even at security=full", async () => {
    const { calls } = await runGatewayExec({ security: "full", ask: "always" });
    expect(calls).toContain("exec.approval.request");
  });

  it("legacy fallback for a config that never set tools.exec keeps asking (reading A)", async () => {
    // No tools.exec keys at all and no approvals file: createExecTool resolves to the legacy
    // fallback (allowlist/on-miss), so an allowlist miss still requires approval. Under the
    // runtime-YOLO reading this would complete with no approval — flipping this assertion is the
    // orchestrator's decision, not a silent change.
    await writeExecApprovalsConfig({ version: 1 });

    const { calls, result } = await runGatewayExec({});

    expect(calls).toContain("exec.approval.request");
    expect(result.details.status).not.toBe("completed");
  });
});
