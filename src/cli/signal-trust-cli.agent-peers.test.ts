/**
 * docs/design/agent-peers-and-quiet-sessions.md §2.1, §2.4 and §4 (mark/unmark via CLI and
 * method, operator-only). Placeholders only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: {
      log: (line: unknown) => logs.push(String(line)),
      error: (line: unknown) => logs.push(String(line)),
      exit: () => {},
    },
  };
});

const { registerSignalTrustCli } = await import("./signal-trust-cli.js");
const { signalTrustHandlers } = await import("../gateway/server-methods/signal-trust.js");
const { authorizeOperatorScopesForMethod, isAdminOnlyMethod } =
  await import("../gateway/method-scopes.js");
const { listGatewayMethods } = await import("../gateway/server-methods-list.js");
const { validateSignalTrustStore } = await import("../signal/trust/store.js");

const UUID_A = "00000000-0000-4000-8000-00000000000a";
const UUID_B = "00000000-0000-4000-8000-00000000000b";

let dir: string;
let prevOauthDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-trust-agents-"));
  prevOauthDir = process.env.OPENCLAW_OAUTH_DIR;
  process.env.OPENCLAW_OAUTH_DIR = dir;
  logs.length = 0;
});

afterEach(() => {
  if (prevOauthDir === undefined) {
    delete process.env.OPENCLAW_OAUTH_DIR;
  } else {
    process.env.OPENCLAW_OAUTH_DIR = prevOauthDir;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerSignalTrustCli(program);
  await program.parseAsync(["node", "openclaw", "signal", "trust", ...args]);
}

function storeFile() {
  return path.join(dir, "signal-trust-default.json");
}

function readStore() {
  return JSON.parse(fs.readFileSync(storeFile(), "utf8")) as {
    trusted: Array<Record<string, unknown>>;
  };
}

async function callMethod(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  await signalTrustHandlers[method]({
    params,
    respond,
    // oxlint-disable-next-line typescript/no-explicit-any
    req: { method } as any,
    client: null,
    isWebchatConnect: () => false,
    // oxlint-disable-next-line typescript/no-explicit-any
    context: {} as any,
  });
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  return { ok, payload, error };
}

describe("signal trust store agent flag (agent peers ARCH §2.1)", () => {
  const base = { version: 1, accountId: "default" };

  it("accepts agent: true on a uuid entry and keeps unmarked stores valid", () => {
    expect(validateSignalTrustStore({ ...base, trusted: [{ uuid: UUID_A }] }, "default")).toBe(
      null,
    );
    expect(
      validateSignalTrustStore({ ...base, trusted: [{ uuid: UUID_A, agent: true }] }, "default"),
    ).toBe(null);
  });

  it("rejects any other agent value and an agent mark without a uuid", () => {
    expect(
      validateSignalTrustStore({ ...base, trusted: [{ uuid: UUID_A, agent: false }] }, "default"),
    ).toMatch(/agent must be true/);
    expect(
      validateSignalTrustStore({ ...base, trusted: [{ uuid: UUID_A, agent: "yes" }] }, "default"),
    ).toMatch(/agent must be true/);
    expect(
      validateSignalTrustStore(
        { ...base, trusted: [{ number: "+15550001111", agent: true }] },
        "default",
      ),
    ).toMatch(/requires a uuid/);
  });
});

describe("signal trust mark-agent / unmark-agent CLI (agent peers ARCH §2.1)", () => {
  it("marks and unmarks an existing trusted uuid without touching other entries", async () => {
    await run("add", UUID_A);
    await run("add", UUID_B);
    await run("mark-agent", `uuid:${UUID_A.toUpperCase()}`);
    let store = readStore();
    expect(store.trusted).toEqual([
      { uuid: UUID_A, addedAt: expect.any(String), agent: true },
      { uuid: UUID_B, addedAt: expect.any(String) },
    ]);
    expect(logs.join("\n")).toContain("Marked as agent");

    await run("mark-agent", UUID_A);
    expect(logs.join("\n")).toContain("Already marked as agent");

    await run("unmark-agent", UUID_A);
    store = readStore();
    expect(store.trusted[0]).toEqual({ uuid: UUID_A, addedAt: expect.any(String) });
    expect("agent" in store.trusted[0]).toBe(false);
  });

  it("refuses to mark an identity that is not in the trust store (never grants trust)", async () => {
    await run("add", UUID_B);
    const before = fs.readFileSync(storeFile(), "utf8");
    await expect(run("mark-agent", UUID_A)).rejects.toThrow(/not in the Signal trust store/);
    expect(fs.readFileSync(storeFile(), "utf8")).toBe(before);
  });

  it("refuses phone numbers", async () => {
    await expect(run("mark-agent", "+15550001111")).rejects.toThrow(/uuid/);
  });

  it("status lists marked agents (ARCH §2.4)", async () => {
    await run("add", UUID_A);
    await run("add", UUID_B);
    logs.length = 0;
    await run("status");
    expect(logs).toContain("marked agents: none");

    await run("mark-agent", UUID_B);
    logs.length = 0;
    await run("status");
    expect(logs).toContain("marked agents: 1");
    expect(logs).toContain(`  uuid:${UUID_B}`);
    expect(logs.join("\n")).not.toContain(`uuid:${UUID_A}`);
  });
});

describe("signal.trust.* gateway methods (agent peers ARCH §2.1)", () => {
  it("are registered and operator.admin only", () => {
    const methods = listGatewayMethods();
    for (const method of [
      "signal.trust.markAgent",
      "signal.trust.unmarkAgent",
      "signal.trust.agents",
    ]) {
      expect(methods).toContain(method);
      expect(isAdminOnlyMethod(method)).toBe(true);
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"]).allowed).toBe(false);
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"]).allowed).toBe(false);
      expect(authorizeOperatorScopesForMethod(method, ["operator.admin"]).allowed).toBe(true);
    }
  });

  it("mark/unmark write the same flag as the CLI and agents lists it", async () => {
    await run("add", UUID_A);
    let res = await callMethod("signal.trust.markAgent", { uuid: UUID_A });
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ uuid: UUID_A, agent: true, changed: true });
    expect(readStore().trusted[0]).toMatchObject({ uuid: UUID_A, agent: true });

    res = await callMethod("signal.trust.agents", {});
    expect(res.payload).toEqual({ accountId: "default", storeValid: true, agents: [UUID_A] });

    res = await callMethod("signal.trust.unmarkAgent", { uuid: `uuid:${UUID_A}` });
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ agent: false, changed: true });
    expect("agent" in readStore().trusted[0]).toBe(false);
  });

  it("rejects bad ids and unknown identities", async () => {
    let res = await callMethod("signal.trust.markAgent", { uuid: "+15550001111" });
    expect(res.ok).toBe(false);
    res = await callMethod("signal.trust.markAgent", { uuid: UUID_A });
    expect(res.ok).toBe(false);
    expect(String(res.error?.message)).toMatch(/not in the Signal trust store/);
    expect(fs.existsSync(storeFile())).toBe(false);
  });
});
