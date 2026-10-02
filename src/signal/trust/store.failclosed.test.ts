import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSignalTrustStoreReader,
  resolveSignalTrustStorePath,
  updateSignalTrustStore,
} from "./store.js";

const NUM_A = "+15550000001";
const UUID_A = "00000000-0000-4000-8000-00000000000a";
const isPosix = process.platform !== "win32";

let stateDir = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-trust-store-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: "" };
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function storePath(accountId = "default") {
  return resolveSignalTrustStorePath(accountId, env);
}

function writeRaw(content: string, mode = 0o600, accountId = "default") {
  const filePath = storePath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

function validDoc(extra: Record<string, unknown> = {}) {
  return { version: 1, accountId: "default", trusted: [{ number: NUM_A }], ...extra };
}

async function read(accountId = "default") {
  return await createSignalTrustStoreReader({ accountId, env }).read();
}

describe("signal trust store path", () => {
  it("is per-account under credentials/ with no legacy unscoped file", () => {
    expect(storePath("default")).toBe(
      path.join(stateDir, "credentials", "signal-trust-default.json"),
    );
    expect(storePath("Work")).toBe(path.join(stateDir, "credentials", "signal-trust-work.json"));
    expect(storePath("../evil")).not.toContain("..");
  });
});

describe("signal trust store fails closed (ARCH §4.5)", () => {
  it("valid store loads", async () => {
    writeRaw(JSON.stringify(validDoc()));
    const snap = await read();
    expect(snap.ok).toBe(true);
  });

  const invalidCases: Array<[string, () => void]> = [
    ["missing file", () => {}],
    ["empty file", () => writeRaw("")],
    ["corrupt JSON", () => writeRaw("{not json")],
    ["JSON array", () => writeRaw("[]")],
    ["wrong version", () => writeRaw(JSON.stringify(validDoc({ version: 2 })))],
    ["account mismatch", () => writeRaw(JSON.stringify(validDoc({ accountId: "other" })))],
    ["unknown top-level key", () => writeRaw(JSON.stringify(validDoc({ allowAll: true })))],
    [
      "unknown entry key",
      () => writeRaw(JSON.stringify(validDoc({ trusted: [{ number: NUM_A, name: "x" }] }))),
    ],
    ["wildcard entry", () => writeRaw(JSON.stringify(validDoc({ trusted: [{ number: "*" }] })))],
    ["wildcard list", () => writeRaw(JSON.stringify(validDoc({ trusted: ["*"] })))],
    [
      "non-canonical number",
      () => writeRaw(JSON.stringify(validDoc({ trusted: [{ number: "+1 555 000 0001" }] }))),
    ],
    [
      "non-canonical uppercase uuid",
      () => writeRaw(JSON.stringify(validDoc({ trusted: [{ uuid: UUID_A.toUpperCase() }] }))),
    ],
    ["entry with neither field", () => writeRaw(JSON.stringify(validDoc({ trusted: [{}] })))],
    [
      "duplicate number",
      () =>
        writeRaw(
          JSON.stringify(
            validDoc({ trusted: [{ number: NUM_A }, { number: NUM_A, uuid: UUID_A }] }),
          ),
        ),
    ],
    [
      "duplicate uuid",
      () => writeRaw(JSON.stringify(validDoc({ trusted: [{ uuid: UUID_A }, { uuid: UUID_A }] }))),
    ],
  ];

  it.each(invalidCases)("%s => deny-all snapshot", async (_label, setup) => {
    setup();
    const snap = await read();
    expect(snap.ok).toBe(false);
  });

  it("an empty trusted list is valid but trusts nobody", async () => {
    writeRaw(JSON.stringify(validDoc({ trusted: [] })));
    const snap = await read();
    expect(snap).toMatchObject({ ok: true, trusted: [] });
  });

  it.runIf(isPosix)("rejects a symlinked store even when the target is valid", async () => {
    const target = path.join(stateDir, "elsewhere.json");
    fs.writeFileSync(target, JSON.stringify(validDoc()), { mode: 0o600 });
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.symlinkSync(target, storePath());
    const snap = await read();
    expect(snap).toMatchObject({ ok: false, error: "store is a symlink" });
  });

  it.runIf(isPosix).each([0o620, 0o602, 0o666])(
    "rejects a group/world-writable store (mode %o)",
    async (mode) => {
      writeRaw(JSON.stringify(validDoc()), mode);
      const snap = await read();
      expect(snap).toMatchObject({ ok: false, error: "store is group- or world-writable" });
    },
  );

  it("rejects a directory at the store path", async () => {
    fs.mkdirSync(storePath(), { recursive: true });
    expect((await read()).ok).toBe(false);
  });
});

describe("signal trust store reload and writes", () => {
  it("reuses the snapshot while the file is unchanged and picks up revocation on next read", async () => {
    await updateSignalTrustStore({
      accountId: "default",
      env,
      mutate: (s) => ({ ...s, trusted: [{ number: NUM_A }] }),
    });
    const reader = createSignalTrustStoreReader({ accountId: "default", env });
    const first = await reader.read();
    const again = await reader.read();
    expect(again).toBe(first);

    await updateSignalTrustStore({
      accountId: "default",
      env,
      mutate: (s) => ({ ...s, trusted: [] }),
    });
    const after = await reader.read();
    expect(after.generation).toBeGreaterThan(first.generation);
    expect(after).toMatchObject({ ok: true, trusted: [] });
  });

  it.runIf(isPosix)("writes 0600 in a 0700 credentials directory", async () => {
    await updateSignalTrustStore({
      accountId: "default",
      env,
      mutate: (s) => ({ ...s, trusted: [{ number: NUM_A }] }),
    });
    expect(fs.statSync(storePath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(storePath())).mode & 0o777).toBe(0o700);
    const leftovers = fs.readdirSync(path.dirname(storePath())).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("refuses to write an invalid store (wildcard)", async () => {
    await expect(
      updateSignalTrustStore({
        accountId: "default",
        env,
        mutate: (s) => ({ ...s, trusted: [{ number: "*" }] }),
      }),
    ).rejects.toThrow(/invalid/);
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("refuses to overwrite a corrupt store instead of silently resetting it", async () => {
    writeRaw("{corrupt");
    await expect(
      updateSignalTrustStore({ accountId: "default", env, mutate: (s) => s }),
    ).rejects.toThrow(/not valid JSON/);
    expect(fs.readFileSync(storePath(), "utf8")).toBe("{corrupt");
  });

  it("keeps accounts isolated", async () => {
    await updateSignalTrustStore({
      accountId: "work",
      env,
      mutate: (s) => ({ ...s, trusted: [{ number: NUM_A }] }),
    });
    expect((await read("default")).ok).toBe(false);
    expect(await read("work")).toMatchObject({ ok: true, trusted: [{ number: NUM_A }] });
  });
});
