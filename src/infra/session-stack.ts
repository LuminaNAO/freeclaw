// Session prompt stack (docs/design/durable-inbox.md §3).
// One file per prompt under <stateDir>/stack/<encoded session key>/<arrival ms>-<n>.json.
// A file on disk means the prompt is unfinished; that is the whole state.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type StackSource = "inbound" | "agent";

export type StackFileContent = {
  source: StackSource;
  payload: unknown;
};

export type StackEntry = {
  file: string;
  arrivalMs: number;
  content: StackFileContent;
};

export type StackSession = {
  sessionKey: string;
  entries: StackEntry[];
};

const FILE_RE = /^(\d+)-(\d+)\.json$/;

export function resolveStackDir(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, "stack");
}

/** Write the prompt (temp file + rename) and return its path. */
export function writeStackFile(params: {
  sessionKey: string;
  source: StackSource;
  payload: unknown;
  stateDir?: string;
}): string {
  const dir = path.join(resolveStackDir(params.stateDir), encodeURIComponent(params.sessionKey));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const arrivalMs = Date.now();
  let n = 0;
  while (fs.existsSync(path.join(dir, `${arrivalMs}-${n}.json`))) {
    n += 1;
  }
  const file = path.join(dir, `${arrivalMs}-${n}.json`);
  const tmp = path.join(dir, `.${arrivalMs}-${n}.json.tmp`);
  const content: StackFileContent = { source: params.source, payload: params.payload };
  fs.writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function deleteStackFile(file: string | undefined): void {
  if (!file) {
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

export function deleteStackFiles(files: string[] | undefined): void {
  for (const file of files ?? []) {
    deleteStackFile(file);
  }
}

/**
 * Whether the gateway is draining for restart (§6). Reads the draining flag the
 * command queue keeps on its shared global state (see process/command-queue.ts).
 */
export function isGatewayDraining(): boolean {
  const state = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.commandQueueState")
  ] as { gatewayDraining?: boolean } | undefined;
  return state?.gatewayDraining === true;
}

/** Every session with files, each oldest first. Reads the files directly. */
export function listStack(stateDir?: string): StackSession[] {
  const root = resolveStackDir(stateDir);
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const sessions: StackSession[] = [];
  for (const dirName of dirs.toSorted()) {
    const dir = path.join(root, dirName);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const entries: Array<StackEntry & { n: number }> = [];
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (!match) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        const content = JSON.parse(fs.readFileSync(file, "utf8")) as StackFileContent;
        entries.push({ file, arrivalMs: Number(match[1]), n: Number(match[2]), content });
      } catch {
        continue;
      }
    }
    if (entries.length === 0) {
      continue;
    }
    entries.sort((a, b) => a.arrivalMs - b.arrivalMs || a.n - b.n);
    sessions.push({
      sessionKey: decodeURIComponent(dirName),
      entries: entries.map(({ file, arrivalMs, content }) => ({ file, arrivalMs, content })),
    });
  }
  return sessions;
}

/** End of the turn that consumed these prompts (§3): delete them, whatever the outcome. */
export function finishStackFiles(files: string[] | undefined): void {
  if (files && files.length > 0) {
    deleteStackFiles(files.splice(0));
  }
}

// Ownership: the prompts a context/queued run currently carries. The array is
// shared, so handing it on (splice) leaves the previous owner with nothing.
const ownedFiles = new WeakMap<object, string[]>();

export function bindStackFiles(owner: object, files: string[] | undefined): void {
  if (files && files.length > 0) {
    ownedFiles.set(owner, files);
  }
}

export function stackFilesOf(owner: object | undefined): string[] | undefined {
  return owner ? ownedFiles.get(owner) : undefined;
}

/** Take the prompts away from their current owner (it no longer ends their turn). */
export function takeStackFiles(owner: object | undefined): string[] {
  return stackFilesOf(owner)?.splice(0) ?? [];
}
