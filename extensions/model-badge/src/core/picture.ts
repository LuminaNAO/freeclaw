import path from "node:path";
import type { CoreFs } from "./fsio.js";

// ARCH §2c.14: ask before painting a group we know nothing about. A group target first
// seen with no avatar gets a picture record; until it is `accepted` nothing is painted for
// it (not even vector) and the writer is not called. The extension never posts and never
// starts a turn: the agent asks in its own reply, told by the two fixed texts below.
//
// Records exist only for groups first seen with no avatar since this section (or declared
// by an operator before first sight): the profile, adopted art, excluded groups and targets
// painted or adopted earlier have none and are untouched.

export type PictureState = "pending" | "asked" | "accepted" | "declined";

export type PictureReason =
  // accepted
  | "purpose-known"
  | "answer"
  | "regenerate"
  | "operator-config"
  | "ask-mode-paint"
  // declined
  | "no-answer";

export type PictureRecord = {
  state: PictureState;
  since: number;
  reason?: PictureReason;
  // pending: when the ask text was last given to a turn of the group's session. A delivered
  // reply after it marks the group asked.
  injectedAt?: number;
  // asked: when the reply carrying the question was delivered (expiry counts from here).
  askedAt?: number;
  // accepted by an answer: what the group is for, one sentence. Never logged; only ever
  // given to the scene writer, which is skipped for a non-private image backend.
  purpose?: string;
};

type Index = { version: 1; targets: Record<string, PictureRecord> };

// The two agent texts (fixed, short; no group name, member names or ids).
export const ASK_TEXT =
  "[model-badge] This group has no picture and its purpose is not known. In this reply, ask " +
  "the members once, in one short line and in the group's language, whether they want a " +
  "group picture and what the group is for. Never ask again after this reply.";

export const ANSWER_TEXT =
  "[model-badge] You asked this group whether it wants a group picture. If a member has " +
  'answered, call the model_badge tool with action "picture" and decision "yes" or "no" ' +
  "(with purpose: one sentence on what the group is for, if they said), and record that " +
  "purpose in this group's memory. If nobody has answered, do not mention it.";

export const PURPOSE_MAX_CHARS = 300;

// One sentence, one line, at most 300 characters. Returns null when empty.
export function cleanPurpose(
  raw: unknown,
): { ok: true; purpose: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, purpose: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "purpose must be text" };
  }
  const purpose = raw.replace(/\s+/g, " ").trim();
  if (!purpose) {
    return { ok: true, purpose: null };
  }
  if (Array.from(purpose).length > PURPOSE_MAX_CHARS) {
    return {
      ok: false,
      error: `purpose must be one sentence of at most ${PURPOSE_MAX_CHARS} characters`,
    };
  }
  return { ok: true, purpose };
}

export function describePicture(rec: PictureRecord | null): string | null {
  if (!rec) {
    return null;
  }
  return rec.reason ? `${rec.state} (${rec.reason})` : rec.state;
}

export function createPictureStore(opts: { fs: CoreFs; dir: string }) {
  const file = path.join(opts.dir, "pictures.json");
  let index: Index = { version: 1, targets: {} };
  let loaded = false;

  async function save() {
    await opts.fs.mkdirp(opts.dir);
    await opts.fs.writeAtomic(file, JSON.stringify(index, null, 1));
  }

  return {
    async load() {
      index = { version: 1, targets: {} };
      try {
        const raw = JSON.parse(await opts.fs.readText(file)) as Partial<Index>;
        if (raw?.targets && typeof raw.targets === "object") {
          index.targets = raw.targets;
        }
      } catch {
        // No records yet.
      }
      loaded = true;
    },
    loaded: () => loaded,
    save,
    get: (key: string): PictureRecord | null => index.targets[key] ?? null,
    async set(key: string, rec: PictureRecord) {
      index.targets[key] = rec;
      await save();
    },
    async remove(key: string): Promise<boolean> {
      if (!index.targets[key]) {
        return false;
      }
      delete index.targets[key];
      await save();
      return true;
    },
    counts(): Record<PictureState, number> {
      const out: Record<PictureState, number> = { pending: 0, asked: 0, accepted: 0, declined: 0 };
      for (const r of Object.values(index.targets)) {
        if (r.state in out) {
          out[r.state]++;
        }
      }
      return out;
    },
  };
}

export type PictureStore = ReturnType<typeof createPictureStore>;
