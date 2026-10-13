/**
 * docs/design/signal-uuid-identity.md §3.3 — `openclaw signal trust add` and
 * `import-allowfrom` write uuids only. Placeholders only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, logs } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  logs: [] as string[],
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: loadConfigMock };
});

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

const UUID = "00000000-0000-4000-8000-00000000000a";
const NUMBER = "+15550001111";

let dir: string;
let prevOauthDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-trust-cli-"));
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

function readStoreRaw(): string {
  return fs.readFileSync(path.join(dir, "signal-trust-default.json"), "utf8");
}

describe("signal trust writes are uuid-only (uuid ARCH §3.3)", () => {
  it("trust add <uuid> stores the uuid", async () => {
    await run("add", `uuid:${UUID.toUpperCase()}`);
    const store = JSON.parse(readStoreRaw());
    expect(store.trusted).toEqual([{ uuid: UUID, addedAt: expect.any(String) }]);
  });

  it("trust add <number> is refused and writes nothing", async () => {
    await expect(run("add", NUMBER)).rejects.toThrow(/uuid/);
    expect(fs.existsSync(path.join(dir, "signal-trust-default.json"))).toBe(false);
  });

  it("trust add <number> <uuid> stores only the uuid", async () => {
    await run("add", NUMBER, UUID);
    const raw = readStoreRaw();
    expect(JSON.parse(raw).trusted).toEqual([{ uuid: UUID, addedAt: expect.any(String) }]);
    expect(raw).not.toContain(NUMBER);
  });

  it("import-allowfrom copies uuid entries and skips phone entries", async () => {
    loadConfigMock.mockReturnValue({
      channels: { signal: { allowFrom: [NUMBER, `uuid:${UUID}`, "*"] } },
    });
    await run("import-allowfrom");
    const raw = readStoreRaw();
    expect(JSON.parse(raw).trusted).toEqual([{ uuid: UUID, addedAt: expect.any(String) }]);
    expect(raw).not.toContain(NUMBER);
    expect(logs.join("\n")).toContain("numbers are not written");
    expect(logs.join("\n")).not.toContain(NUMBER);
  });
});
