import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./store.js";

// Partitioned lanes (ARCH §4.2): the lead's split lives in the holon's plan.md (one line per
// member); member n works in worktree <dir>/worktrees/<id>-p<n> on branch <id>-p<n>; when all
// members are done, the parts merge into the holon branch (v1: the checked-out branch).

export type Partition = {
  repo: string;
  /** Holon branch: the checked-out branch of `repo` at start (v1: workers commit on it). */
  base: string;
  /** Member branch/worktree suffixes, `<base>-p<n>`. */
  members: string[];
};

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    ...(env && { env }),
  })
    .toString()
    .trim();
}

/**
 * The merge commit is the swarm's bookkeeping, not an author: it uses the repo's own
 * configured identity, or a neutral one when the repo has none (a fresh scratch repo).
 */
function gitEnv(repo: string): NodeJS.ProcessEnv {
  const get = (key: string) => {
    try {
      return gitPlain(repo, ["config", "--get", key]) || undefined;
    } catch {
      return undefined;
    }
  };
  const name = get("user.name") ?? "swarm";
  const email = get("user.email") ?? "swarm@localhost";
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function gitOk(repo: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(repo, args, gitEnv(repo)) };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    return { ok: false, out: stderr || String(err) };
  }
}

/** Plain git without the identity env (config queries and ref lookups). */
function gitPlain(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

export function holonBranch(repo: string): string {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
}

/**
 * The one name of a member's branch (ARCH §4.2: <holon-branch>-p<n>). Setup, the member brief
 * and the merge all use this; the holon branch is the repo's checked-out branch at start, so
 * it survives restarts (it is never stored).
 */
export function memberBranch(base: string, n: number): string {
  return `${base}-p${n}`;
}

export function memberWorktree(repo: string, base: string, n: number): string {
  return path.join(repo, "worktrees", memberBranch(base, n));
}

/**
 * One worktree + branch per member of a partitioned lane. Idempotent: an existing worktree is
 * reused (resume after a restart must never destroy work).
 */
export function setupPartition(repo: string, base: string, count: number): Partition {
  const members: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const branch = memberBranch(base, n);
    const dir = memberWorktree(repo, base, n);
    if (!fs.existsSync(dir)) {
      const branchExists = gitOk(repo, ["rev-parse", "--verify", "--quiet", branch]).ok;
      git(repo, ["worktree", "add", dir, ...(branchExists ? [branch] : ["-b", branch])]);
    }
    members.push(branch);
  }
  return { repo, base, members };
}

/** The lead's split, one scope per member; read back for member briefs (§4.2). */
export function writePlan(holonDir: string, scopes: string[]): void {
  writeFileAtomic(path.join(holonDir, "plan.md"), `${scopes.join("\n")}\n`);
}

export function readPlan(holonDir: string): string[] {
  try {
    return fs
      .readFileSync(path.join(holonDir, "plan.md"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; conflicted: string; detail: string };

/**
 * Merge every member branch into the holon branch in order (§4.2: the join of a partitioned
 * lane). On a conflict the merge is aborted and the branch name is returned for the lead.
 */
export function mergePartition(repo: string, base: string, members: string[]): MergeResult {
  for (const branch of members) {
    const merged = gitOk(repo, ["merge", "--no-ff", "-m", `swarm: merge ${branch}`, branch]);
    if (!merged.ok) {
      const aborted = gitOk(repo, ["merge", "--abort"]);
      return {
        ok: false,
        conflicted: branch,
        detail: `${merged.out}${aborted.ok ? "" : `\n(merge --abort failed: ${aborted.out})`}`,
      };
    }
  }
  return { ok: true, sha: git(repo, ["rev-parse", "HEAD"]) };
}
