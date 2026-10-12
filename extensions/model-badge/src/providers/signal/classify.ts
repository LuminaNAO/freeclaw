import type { ApplyResult } from "../../core/provider.js";

// Maps a signal-cli JSON-RPC outcome to the core's ApplyResult (ported from the
// certified standalone classifier; patterns derived from signal-cli source, see
// fixtures.ts for the response each branch was written against).

export type RpcOutcome =
  | {
      transport: "ok";
      body: { result?: unknown; error?: { code?: number | string; message?: string } };
    }
  | { transport: "refused" }
  | { transport: "timeout" }
  | { transport: "http"; status: number; retryAfterMs?: number };

const NOT_FOUND = [/^Group not found: /, /^User is not a member in group: /];
const NOT_ALLOWED = [/^User is not allowed to send message to group: /];
// GV1 groups (UpdateGroupCommand): the daemon could not attach the avatar.
const GV1_AVATAR = /^Failed to add avatar attachment for group/;
const PROFILE_IO = /^Update profile error: /;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The daemon failed to open the avatar path we passed. java.io.FileInputStream reports
// "<path> (<reason>)"; signal-cli wraps it as -32603 "... (FileNotFoundException) ..."
// for groups and -3 "Update profile error: <path> (<reason>)" for the profile, so our
// own path followed by " (" is the reliable discriminator.
function avatarUnreadable(msg: string, avatarPath?: string): boolean {
  if (GV1_AVATAR.test(msg)) {
    return true;
  }
  if (avatarPath && new RegExp(`(?:^|: )${escapeRe(avatarPath)} \\(`).test(msg)) {
    return true;
  }
  return /\((FileNotFoundException|NoSuchFileException|AccessDeniedException)\)/.test(msg);
}

type SendEntry = { type?: unknown; token?: unknown; retryAfterSeconds?: unknown };

function rateLimitEntries(result: unknown): SendEntry[] {
  const list = (result as { results?: unknown } | undefined)?.results;
  return Array.isArray(list)
    ? (list as SendEntry[]).filter((r) => r?.type === "RATE_LIMIT_FAILURE")
    : [];
}

export function classify(
  outcome: RpcOutcome,
  ctx: { kind: "group" | "profile"; avatarPath?: string },
): ApplyResult {
  if (outcome.transport === "refused" || outcome.transport === "timeout") {
    return { kind: "pause", reason: "daemon-down" };
  }
  if (outcome.transport === "http") {
    // Defensive fallback: the daemon's HTTP layer does not emit 423/429 today.
    if (outcome.status === 423 || outcome.status === 429) {
      return { kind: "rate-limit-uncommitted", retryAfterMs: outcome.retryAfterMs };
    }
    return { kind: "pause", reason: "daemon-down" };
  }
  const body = outcome.body ?? {};
  if (body.error) {
    const code = Number(body.error.code);
    const msg = String(body.error.message ?? "");
    if (code === -5) {
      return { kind: "rate-limit-uncommitted" }; // defensive fallback
    }
    if (avatarUnreadable(msg, ctx.avatarPath)) {
      return {
        kind: "config",
        source: "avatar",
        message:
          "the Signal daemon cannot read the avatar file; the cache dir must be readable by the daemon",
      };
    }
    if (code === -1) {
      if (NOT_FOUND.some((re) => re.test(msg))) {
        return { kind: "permanent", reason: "not-found", message: msg };
      }
      if (NOT_ALLOWED.some((re) => re.test(msg))) {
        return { kind: "permanent", reason: "permission", message: msg };
      }
      return { kind: "error", message: msg };
    }
    // Any other profile I/O failure is Signal-side: pause, never park.
    if (code === -3 && ctx.kind === "profile" && PROFILE_IO.test(msg)) {
      return { kind: "pause", reason: "provider-io", neverPark: true };
    }
    if (code === -32603) {
      return { kind: "pause", reason: "provider-io" };
    }
    if (code === -32600 || code === -32601 || code === -32602) {
      return /account/i.test(msg)
        ? { kind: "config", message: msg }
        : { kind: "error", message: msg };
    }
    return { kind: "error", message: `code ${body.error.code}: ${msg}` };
  }
  const limited = rateLimitEntries(body.result);
  if (limited.length > 0) {
    const captcha = limited.filter((r) => r.token != null || r.retryAfterSeconds != null);
    if (captcha.length > 0) {
      const secs = Math.max(0, ...captcha.map((r) => Number(r.retryAfterSeconds) || 0));
      // Per-recipient results only exist in a success response, returned after the
      // change was committed on the server: the fan-out was limited, not the change.
      return { kind: "captcha", committed: true, retryAfterMs: secs ? secs * 1000 : undefined };
    }
    return { kind: "ok-rate-limited" };
  }
  return { kind: "ok" };
}

// freeclaw's Signal client returns the `result` on success and throws an Error for
// everything else. This turns that back into an outcome the classifier understands,
// for both the HTTP and the unix-socket transport.
export function outcomeFromError(err: unknown): RpcOutcome {
  const e = err as { name?: string; message?: string; cause?: { code?: string } } | undefined;
  const msg = String(e?.message ?? err);
  const rpc = /^Signal RPC (-?\d+|unknown): ([\s\S]*)$/.exec(msg);
  if (rpc) {
    return {
      transport: "ok",
      body: { error: { code: rpc[1] === "unknown" ? "unknown" : Number(rpc[1]), message: rpc[2] } },
    };
  }
  const status = /\(status (\d{3})\)/.exec(msg);
  if (status) {
    return { transport: "http", status: Number(status[1]) };
  }
  if (e?.name === "AbortError" || e?.name === "TimeoutError" || /timed out/i.test(msg)) {
    return { transport: "timeout" };
  }
  // Connection refused/reset, socket missing or closed, fetch failure: the daemon is
  // not answering. A pause, never a per-target failure.
  return { transport: "refused" };
}
