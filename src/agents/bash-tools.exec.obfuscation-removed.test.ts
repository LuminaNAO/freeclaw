import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../config/config.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";

/**
 * The command-obfuscation detector must be out of the exec approval path. It used to force
 * approval even when config said ask=off, and chat channels cannot approve — so legitimate
 * heredoc / base64 work simply failed. These tests deliberately do NOT mock the detector
 * (unlike bash-tools.exec.approval-id.test.ts) and do NOT import it (so they still compile
 * once src/infra/exec-obfuscation-detect.ts is deleted): the real detector flags these
 * commands today, and the assertion is that flagging no longer gates execution.
 */

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [{ nodeId: "node-1", commands: ["system.run"], platform: "linux" }]),
  resolveNodeIdFromList: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;

// `bash <<'SH'` trips shell-heredoc-exec; the base64 pipe trips base64-pipe-exec.
// The base64 payload decodes to a valid command (echo OBSTRUCTION_OK) so the test asserts on
// approval gating, not on a malformed-command failure.
const HEREDOC_BASE64_COMMAND = [
  "bash <<'SH'",
  "echo ZWNobyBPQlNUUlVDVElPTl9PSwo= | base64 -d | bash",
  "SH",
].join("\n");
const BASE64_PIPE_COMMAND = "echo ZWNobyBPQlNUUlVDVElPTl9PSwo= | base64 -d | bash";

function buildPreparedSystemRunPayload(rawInvokeParams: unknown) {
  const invoke = (rawInvokeParams ?? {}) as {
    params?: Record<string, unknown>;
  };
  return buildSystemRunPreparePayload(invoke.params ?? {});
}

async function writeExecApprovalsConfig(config: Record<string, unknown>) {
  const approvalsPath = path.join(process.env.HOME ?? "", ".openclaw", "exec-approvals.json");
  await fs.mkdir(path.dirname(approvalsPath), { recursive: true });
  await fs.writeFile(approvalsPath, JSON.stringify(config, null, 2));
}

describe("runcap: obfuscation detector no longer gates exec", () => {
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ createExecTool } = await import("./bash-tools.exec.js"));
  });

  beforeEach(async () => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runcap-obf-"));
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

  async function runGatewayExec(command: string) {
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      return { ok: true };
    });

    // ask=off + security=full: nothing in config asks for approval.
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      approvalRunningNoticeMs: 0,
    });
    const result = await tool.execute("call-obfuscation", { command });
    return { calls, result };
  }

  it("runs a heredoc + base64 command with no approval when ask=off", async () => {
    await writeExecApprovalsConfig({ version: 1, defaults: { security: "full", ask: "off" } });

    const { calls, result } = await runGatewayExec(HEREDOC_BASE64_COMMAND);

    expect(result.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });

  it("runs a base64-pipe-to-shell command with no approval when ask=off", async () => {
    await writeExecApprovalsConfig({ version: 1, defaults: { security: "full", ask: "off" } });

    const { calls, result } = await runGatewayExec(BASE64_PIPE_COMMAND);

    expect(result.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
  });

  it("never warns about an obfuscated command", async () => {
    await writeExecApprovalsConfig({ version: 1, defaults: { security: "full", ask: "off" } });

    const { result } = await runGatewayExec(HEREDOC_BASE64_COMMAND);

    const text = result.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n")
      .toLowerCase();
    expect(text).not.toContain("obfuscated");
    expect(text).not.toContain("obfuscation");
  });

  it("runs the same commands on the node host with no approval when ask=off", async () => {
    await writeExecApprovalsConfig({ version: 1, defaults: { security: "full", ask: "off" } });

    const calls: string[] = [];
    const nodeInvokeCommands: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        return { status: "accepted", id: (params as { id?: string })?.id };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "allow-once" };
      }
      if (method === "node.invoke") {
        const invoke = params as { command?: string };
        if (invoke.command) {
          nodeInvokeCommands.push(invoke.command);
        }
        if (invoke.command === "system.run.prepare") {
          return buildPreparedSystemRunPayload(params);
        }
        return { payload: { success: true, stdout: "hello\n", exitCode: 0 } };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      host: "node",
      node: "node-1",
      security: "full",
      ask: "off",
      approvalRunningNoticeMs: 0,
    });
    const result = await tool.execute("call-node-obfuscation", {
      command: HEREDOC_BASE64_COMMAND,
    });

    // No approval round-trip, and the command actually reached the node.
    expect(calls).not.toContain("exec.approval.request");
    expect(result.details.status).not.toBe("approval-pending");
    expect(nodeInvokeCommands).toContain("system.run");
  });
});
