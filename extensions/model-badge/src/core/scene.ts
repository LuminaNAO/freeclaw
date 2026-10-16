import path from "node:path";
import { BANNED_PROMPT_WORDS } from "./baseart.js";
import type { ImageGenConfig } from "./config.js";
import type { CoreFs } from "./fsio.js";

// ARCH §2c.11: a new group's image scene is written by the agent from what the group is.
// This module is the pure half: the writer's input, the validation of what it returns,
// the loopback/private guard on the image backend, and the per-target scene cache. The
// agent run itself lives outside the core (src/scene-writer.ts).

export const SCENE_MAX_WORDS = 40;
export const DEFAULT_WRITER_TIMEOUT_MS = 60_000;
// Top few memory snippets, each kept short.
export const WRITER_MAX_SNIPPETS = 3;
const SNIPPET_MAX_CHARS = 280;

// ---------------- writer input ----------------

// The only inputs: the group name and the agent's own memory snippets for it. No chat
// messages, member names or numbers (there are none at creation anyway).
export type SceneWriterInput = { name: string; snippets: string[] };

// What the plugin runtime does with that input: one short agent run in a throwaway
// session that returns the agent's text. `memory: false` sends no snippets.
export type SceneWriteRequest = {
  name: string;
  memory: boolean;
  model?: string;
  timeoutMs: number;
};
export interface SceneWriter {
  write(req: SceneWriteRequest): Promise<string>;
}

export const WRITER_INSTRUCTION = [
  "You write one image prompt for a chat group's picture.",
  `Return ONE concrete visual scene, at most ${SCENE_MAX_WORDS} words, that evokes what the group is likely about.`,
  "No text, letters, words, logos, brand names, real people or faces in the scene.",
  "Never quote or repeat the group name, and use no quotation marks.",
  "Write in lower case, on a single line, with no preamble.",
  "Do not use any tools. Reply with the scene only.",
].join("\n");

// Memory snippets are reduced to plain short text: one line, digit runs (numbers, ids)
// removed, length bounded.
export function cleanSnippet(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\+?\d(?:[\s().-]?\d){3,}/g, " ")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, SNIPPET_MAX_CHARS);
}

export function buildWriterMessage(input: SceneWriterInput): string {
  const name = input.name.replace(/[\r\n]+/g, " ").trim();
  const lines = [`Group name: ${name}`];
  const snippets = input.snippets.map(cleanSnippet).filter(Boolean).slice(0, WRITER_MAX_SNIPPETS);
  if (snippets.length) {
    lines.push("", "What your memory says about it:", ...snippets.map((s) => `- ${s}`));
  }
  lines.push("", "Write the scene now.");
  return lines.join("\n");
}

// ---------------- validation ----------------

export type SceneVerdict =
  | { ok: true; scene: string }
  | {
      ok: false;
      reason:
        | "empty"
        | "multi-line"
        | "too-long"
        | "quotes"
        | "banned-word"
        | "digits"
        | "name"
        | "markup";
    };

const BANNED_RE = new RegExp(`\\b(?:${BANNED_PROMPT_WORDS.join("|")})s?\\b`, "i");
// Double quotes, curly quotes, guillemets, backticks; a straight single quote counts as a
// quote unless it sits between two letters (an apostrophe: "children's").
const QUOTES_RE = /["“”„‟«»‹›`‘’‚‛]|(?<![\p{L}])'|'(?![\p{L}])/u;
// Id-like digit runs: four or more digits, separators allowed (numbers, ids, phones).
const DIGITS_RE = /\d(?:[\s().+-]?\d){3,}/;
// Long opaque runs (base64 group ids, uuids without dashes).
const OPAQUE_RE = /[A-Za-z0-9+/=_-]{24,}/;
const MARKUP_RE = /[<>{}[\]\\|#*_~]|[\u0000-\u001f\u007f]/;

function nameTokens(name: string): string[] {
  return name.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
}

const isCapitalised = (w: string) => /^\p{Lu}/u.test(w);
// Inner capitals or digits mark a coined name ("McAllister", "iPhone", "Ops42").
const isCoined = (w: string) => /\p{N}/u.test(w) || /.\p{Lu}/u.test(w);

// A proper noun taken from the group name: a capitalised (or coined) word of the name
// used capitalised in the scene, a coined word used in any case, or the whole name.
function usesNameProperNoun(scene: string, name: string): boolean {
  const tokens = nameTokens(name).filter((t) => t.replace(/['-]/g, "").length >= 2);
  const proper = new Map<string, boolean>();
  for (const t of tokens) {
    if (isCapitalised(t) || isCoined(t)) {
      proper.set(t.toLowerCase(), isCoined(t));
    }
  }
  for (const w of nameTokens(scene)) {
    const lower = w.toLowerCase().replace(/'s$/, "");
    if (!proper.has(lower)) {
      continue;
    }
    if (proper.get(lower) || isCapitalised(w)) {
      return true;
    }
  }
  const whole = name.trim().toLowerCase().replace(/\s+/g, " ");
  return tokens.length >= 2 && scene.toLowerCase().replace(/\s+/g, " ").includes(whole);
}

export function validateScene(raw: unknown, groupName: string): SceneVerdict {
  if (typeof raw !== "string") {
    return { ok: false, reason: "empty" };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty" };
  }
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, reason: "multi-line" };
  }
  const scene = trimmed.replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  if (!scene) {
    return { ok: false, reason: "empty" };
  }
  if (scene.split(" ").filter(Boolean).length > SCENE_MAX_WORDS) {
    return { ok: false, reason: "too-long" };
  }
  if (QUOTES_RE.test(scene)) {
    return { ok: false, reason: "quotes" };
  }
  if (MARKUP_RE.test(scene)) {
    return { ok: false, reason: "markup" };
  }
  if (BANNED_RE.test(scene)) {
    return { ok: false, reason: "banned-word" };
  }
  if (DIGITS_RE.test(scene) || OPAQUE_RE.test(scene)) {
    return { ok: false, reason: "digits" };
  }
  if (usesNameProperNoun(scene, groupName)) {
    return { ok: false, reason: "name" };
  }
  return { ok: true, scene };
}

// ---------------- boundary: the image backend must be on this box or the LAN ----------------

function ipv4Private(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) {
    return false;
  }
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) {
    return false;
  }
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Loopback or a private address (RFC 1918, IPv6 loopback and unique-local). A hostname
// other than localhost cannot be known to be private without resolving it, so it is not.
export function isPrivateHost(hostname: string): boolean {
  const h = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) {
    return true;
  }
  if (ipv4Private(h)) {
    return true;
  }
  if (h === "::1") {
    return true;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) {
    return ipv4Private(mapped[1] as string);
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(h);
}

// ARCH §2c.11 boundary: names and memory may only reach an image backend on this box or a
// private address. The command backend is a local process fed on stdin (§2b.1).
export function imageGenIsPrivate(cfg: ImageGenConfig | null): boolean {
  if (!cfg) {
    return false;
  }
  if (cfg.kind === "command") {
    return true;
  }
  try {
    return isPrivateHost(new URL(cfg.baseUrl).hostname);
  } catch {
    return false;
  }
}

// ---------------- per-target scene cache ----------------

// `name` is the latest group name the hook reported. `record` is the outcome for one
// (name, generation): the written scene, or the motif fallback and why. The same inputs
// never call the writer twice.
export type SceneRecord = {
  name: string;
  generation: number;
  source: "writer" | "motif";
  scene?: string;
  why?: string;
  at: number;
};
type SceneEntry = { name?: string; record?: SceneRecord };
type SceneIndex = { version: 1; targets: Record<string, SceneEntry> };

export function createSceneStore(opts: { fs: CoreFs; dir: string }) {
  const file = path.join(opts.dir, "scenes.json");
  let index: SceneIndex = { version: 1, targets: {} };
  // Names reported before the state was loaded, or while another instance is the writer
  // (the hook can fire during start-up or in standby); merged on the next load.
  const early = new Map<string, string>();

  return {
    // Returns how many early names were merged in (the caller saves them).
    async load(): Promise<number> {
      index = { version: 1, targets: {} };
      try {
        const raw = JSON.parse(await opts.fs.readText(file)) as Partial<SceneIndex>;
        if (raw?.targets && typeof raw.targets === "object") {
          index.targets = raw.targets;
        }
      } catch {
        // No scenes yet.
      }
      const merged = early.size;
      for (const [k, name] of early) {
        (index.targets[k] ??= {}).name = name;
      }
      early.clear();
      return merged;
    },
    async save() {
      await opts.fs.mkdirp(opts.dir);
      await opts.fs.writeAtomic(file, JSON.stringify(index, null, 1));
    },
    name(key: string): string | null {
      return early.get(key) ?? index.targets[key]?.name ?? null;
    },
    // Returns whether the name changed.
    setName(key: string, name: string, opts2: { loaded: boolean }): boolean {
      if (!opts2.loaded) {
        const changed = (early.get(key) ?? index.targets[key]?.name) !== name;
        early.set(key, name);
        return changed;
      }
      const e = (index.targets[key] ??= {});
      if (e.name === name) {
        return false;
      }
      e.name = name;
      return true;
    },
    record(key: string, name: string, generation: number): SceneRecord | null {
      const r = index.targets[key]?.record;
      return r && r.name === name && r.generation === generation ? r : null;
    },
    setRecord(key: string, rec: SceneRecord) {
      (index.targets[key] ??= {}).record = rec;
    },
    remove(key: string): boolean {
      early.delete(key);
      if (!index.targets[key]) {
        return false;
      }
      delete index.targets[key];
      return true;
    },
    size: () => Object.keys(index.targets).length,
  };
}

export type SceneStore = ReturnType<typeof createSceneStore>;
