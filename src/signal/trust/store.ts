import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir } from "../../config/paths.js";
import { withFileLock } from "../../infra/file-lock.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { isCanonicalTrustNumber, isCanonicalTrustUuid, type SignalTrustEntry } from "./identity.js";

export const SIGNAL_TRUST_STORE_VERSION = 1;

export type SignalTrustStoreFile = {
  version: typeof SIGNAL_TRUST_STORE_VERSION;
  accountId: string;
  trusted: SignalTrustEntry[];
};

export type SignalTrustSnapshot =
  | { ok: true; generation: number; trusted: readonly SignalTrustEntry[] }
  | { ok: false; generation: number; error: string };

const STORE_KEYS = new Set(["version", "accountId", "trusted"]);
const ENTRY_KEYS = new Set(["number", "uuid", "addedAt"]);
const LOCK_OPTIONS = {
  retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 2_000, randomize: true },
  stale: 30_000,
} as const;

/** Same sanitization as the pairing store's account key (path-traversal safe). */
function safeAccountKey(accountId: string): string {
  const raw = normalizeAccountId(accountId).toLowerCase();
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid signal trust account id");
  }
  return safe;
}

export function resolveSignalTrustStorePath(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveOAuthDir(env), `signal-trust-${safeAccountKey(accountId)}.json`);
}

/** Returns an error string, or null when the parsed document is a valid store for accountId. */
export function validateSignalTrustStore(value: unknown, accountId: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "store is not a JSON object";
  }
  const doc = value as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!STORE_KEYS.has(key)) {
      return `unknown top-level key "${key}"`;
    }
  }
  if (doc.version !== SIGNAL_TRUST_STORE_VERSION) {
    return "unsupported store version";
  }
  if (doc.accountId !== normalizeAccountId(accountId)) {
    return "store accountId does not match this account";
  }
  if (!Array.isArray(doc.trusted)) {
    return '"trusted" must be an array';
  }
  const numbers = new Set<string>();
  const uuids = new Set<string>();
  for (const [index, rawEntry] of doc.trusted.entries()) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      return `trusted[${index}] is not an object`;
    }
    const entry = rawEntry as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) {
        return `trusted[${index}] has unknown key "${key}"`;
      }
    }
    if (entry.number === undefined && entry.uuid === undefined) {
      return `trusted[${index}] has neither number nor uuid`;
    }
    if (entry.number !== undefined) {
      if (!isCanonicalTrustNumber(entry.number)) {
        return `trusted[${index}].number is not canonical E.164`;
      }
      if (numbers.has(entry.number)) {
        return `trusted[${index}].number is a duplicate`;
      }
      numbers.add(entry.number);
    }
    if (entry.uuid !== undefined) {
      if (!isCanonicalTrustUuid(entry.uuid)) {
        return `trusted[${index}].uuid is not a canonical lowercase uuid`;
      }
      if (uuids.has(entry.uuid)) {
        return `trusted[${index}].uuid is a duplicate`;
      }
      uuids.add(entry.uuid);
    }
    if (entry.addedAt !== undefined && typeof entry.addedAt !== "string") {
      return `trusted[${index}].addedAt must be a string`;
    }
  }
  return null;
}

function checkFileSafety(stat: fs.Stats): string | null {
  if (stat.isSymbolicLink()) {
    return "store is a symlink";
  }
  if (!stat.isFile()) {
    return "store is not a regular file";
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o022) !== 0) {
      return "store is group- or world-writable";
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      return "store is not owned by the gateway user";
    }
  }
  return null;
}

/**
 * lstat-keyed snapshot reader. Every call re-lstats the store; the file is re-read and
 * re-validated only when dev/ino/mtime/size/mode change. Any failure is a deny-all snapshot.
 */
export function createSignalTrustStoreReader(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  filePath?: string;
}) {
  const filePath = params.filePath ?? resolveSignalTrustStorePath(params.accountId, params.env);
  let cacheKey: string | null = null;
  let snapshot: SignalTrustSnapshot | null = null;
  let generation = 0;

  type SnapshotBody =
    | { ok: true; trusted: readonly SignalTrustEntry[] }
    | { ok: false; error: string };
  const setSnapshot = (key: string, next: SnapshotBody): SignalTrustSnapshot => {
    if (cacheKey === key && snapshot) {
      return snapshot;
    }
    generation += 1;
    cacheKey = key;
    snapshot = { ...next, generation };
    return snapshot;
  };

  async function read(): Promise<SignalTrustSnapshot> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const error = code === "ENOENT" ? "store file is missing" : "store file is unreadable";
      return setSnapshot(`err:${error}`, { ok: false, error });
    }
    const key = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}:${stat.mode}:${stat.uid}`;
    if (key === cacheKey && snapshot) {
      return snapshot;
    }
    const unsafe = checkFileSafety(stat);
    if (unsafe) {
      return setSnapshot(key, { ok: false, error: unsafe });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    } catch {
      return setSnapshot(key, { ok: false, error: "store is unreadable or not valid JSON" });
    }
    const invalid = validateSignalTrustStore(parsed, params.accountId);
    if (invalid) {
      return setSnapshot(key, { ok: false, error: invalid });
    }
    const trusted = (parsed as SignalTrustStoreFile).trusted.map((entry) =>
      Object.freeze({ ...entry }),
    );
    return setSnapshot(key, { ok: true, trusted: Object.freeze(trusted) });
  }

  return { filePath, read };
}

/** tmp (0600) -> fsync -> rename; the rename changes the inode so readers see it on next lstat. */
async function writeStoreAtomic(filePath: string, value: SignalTrustStoreFile): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.promises.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, filePath);
    if (process.platform !== "win32") {
      await fs.promises.chmod(filePath, 0o600);
    }
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function readForUpdate(filePath: string, accountId: string): Promise<SignalTrustStoreFile> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return {
        version: SIGNAL_TRUST_STORE_VERSION,
        accountId: normalizeAccountId(accountId),
        trusted: [],
      };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Signal trust store ${filePath} is not valid JSON; fix or remove it first.`);
  }
  const invalid = validateSignalTrustStore(parsed, accountId);
  if (invalid) {
    throw new Error(`Signal trust store ${filePath} is invalid (${invalid}); fix it first.`);
  }
  return parsed as SignalTrustStoreFile;
}

/**
 * Operator-only writer (CLI). Locked read-modify-write, written atomically (tmp + rename) at 0600
 * inside a 0700 directory. The mutation must return a store that still validates.
 */
export async function updateSignalTrustStore(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  mutate: (current: SignalTrustStoreFile) => SignalTrustStoreFile | null;
}): Promise<{ changed: boolean; store: SignalTrustStoreFile; filePath: string }> {
  const filePath = resolveSignalTrustStorePath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.promises.chmod(dir, 0o700);
  }
  return await withFileLock(filePath, LOCK_OPTIONS, async () => {
    const current = await readForUpdate(filePath, params.accountId);
    const next = params.mutate(current);
    if (!next) {
      return { changed: false, store: current, filePath };
    }
    const invalid = validateSignalTrustStore(next, params.accountId);
    if (invalid) {
      throw new Error(`refusing to write invalid Signal trust store: ${invalid}`);
    }
    await writeStoreAtomic(filePath, next);
    return { changed: true, store: next, filePath };
  });
}

export async function readSignalTrustStoreForCli(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ filePath: string; snapshot: SignalTrustSnapshot }> {
  const reader = createSignalTrustStoreReader(params);
  return { filePath: reader.filePath, snapshot: await reader.read() };
}
