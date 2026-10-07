import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Shared fixtures for swarm plugin tests. Generic placeholders only — never real
 * names, hosts, ids, or numbers.
 *
 * COST RULE (operator): every worker + the taskmaster defaults to sonnet with
 * thinking off. The only exception is the per-worker-model proof (ARCH 10.5),
 * where exactly one worker runs on the k3-256k provider; everything else stays
 * sonnet. Never an expensive model in fixtures.
 */
const DEFAULT_WORKER_MODEL = "cb-sonnet/claude-sonnet-5-5";

export function seedTask(
  stateDir: string,
  opts: { taskId: string; headSha: string; upstreamSessionKey?: string; repo?: string },
): string {
  const taskDir = path.join(stateDir, "swarm", opts.taskId);
  mkdirSync(taskDir, { recursive: true });
  const upstream = opts.upstreamSessionKey ?? "agent:main:swarm-upstream";
  const repo = opts.repo ?? "/tmp/swarm-fixture-repo";
  writeFileSync(
    path.join(taskDir, "contract.yaml"),
    `id: ${opts.taskId}
kind: build
input: dummy build task
done_when: unit test passes on head
workers:
  build: { count: 1, model: ${DEFAULT_WORKER_MODEL}, thinking: "off" }
  audit: { count: 1, model: ${DEFAULT_WORKER_MODEL}, thinking: "off" }
  test: { count: 1, model: ${DEFAULT_WORKER_MODEL}, thinking: "off" }
upstream:
  sessionKey: ${upstream}
  events: [DONE, BLOCKED, FAILED]
budget: { wall: 4h, step_silence: 30m }
repo: ${repo}
`,
  );
  // Task index per the on-disk layout: status + tracked head sha.
  writeFileSync(
    path.join(stateDir, "swarm", "tasks.json"),
    JSON.stringify(
      {
        [opts.taskId]: {
          status: "open",
          sha: opts.headSha,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      null,
      2,
    ),
  );
  return taskDir;
}

/** Creates a scratch git repo in a temp dir with one commit; returns its path. */
export function initScratchRepo(): string {
  const repoDir = mkdtempSync(path.join(tmpdir(), "swarm-fixture-repo-"));
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "swarm-test",
        GIT_AUTHOR_EMAIL: "swarm-test@example.org",
        GIT_COMMITTER_NAME: "swarm-test",
        GIT_COMMITTER_EMAIL: "swarm-test@example.org",
      },
    });
  git(["init", "-q"]);
  writeFileSync(path.join(repoDir, "index.js"), "export const hello = (n) => `hello ${n}`;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);
  return repoDir;
}

export function gitHead(repoDir: string): string {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoDir }).toString().trim();
}

export function commitScratchChange(repoDir: string): void {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "swarm-test",
        GIT_AUTHOR_EMAIL: "swarm-test@example.org",
        GIT_COMMITTER_NAME: "swarm-test",
        GIT_COMMITTER_EMAIL: "swarm-test@example.org",
      },
    });
  writeFileSync(path.join(repoDir, "extra.js"), `export const n = ${Date.now()};\n`);
  git(["add", "-A"]);
  git(["commit", "-qm", "worker change"]);
}
