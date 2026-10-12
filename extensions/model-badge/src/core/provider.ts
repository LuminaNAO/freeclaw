// ARCH §4.1: the channel-agnostic core speaks to a channel only through this interface.
// Providers own session-key mapping, target enumeration, id resolution, the write call
// and turning the channel's responses into a classified ApplyResult. The core never
// imports a provider.

export type TargetKind = "group" | "profile";

// idLower is the provider's canonical (lowercased) target id. It is the `targetId` used
// in config (`targets.<targetId>`), steering rules and the base seed.
export type TargetRef = { kind: TargetKind; idLower: string };

export type ProviderTarget = {
  ref: TargetRef;
  member: boolean;
  canEdit: boolean | "unknown";
};

export type ApplyResult =
  | { kind: "ok" }
  // Committed, but the account hit a limit: pause the whole queue.
  | { kind: "ok-rate-limited"; retryAfterMs?: number }
  // Operator action needed. `committed` when the change went through anyway.
  | { kind: "captcha"; committed: boolean; retryAfterMs?: number }
  | {
      kind: "pause";
      reason: "daemon-down" | "provider-io";
      retryAfterMs?: number;
      neverPark?: boolean;
    }
  | { kind: "permanent"; reason: "not-found" | "permission" | "ambiguous-id"; message: string }
  | { kind: "error"; message: string }
  // The provider cannot work as configured (e.g. the daemon cannot read the asset).
  | { kind: "config"; message: string; source?: "avatar" }
  // Defensive fallback: a rate limit that did not commit. Pause, not applied.
  | { kind: "rate-limit-uncommitted"; retryAfterMs?: number };

export type ResolveResult = { ok: true; realId: string } | { ok: false; result: ApplyResult };

export type ListResult =
  | { ok: true; targets: ProviderTarget[] }
  | { ok: false; result: ApplyResult };

export type ProviderProfile = {
  ref: TargetRef;
  sessionKey: string;
  // Optional operator image used instead of the generated portrait base (ARCH §2.3).
  baseImage: string | null;
};

export interface BadgeProvider {
  readonly id: string;
  readonly asset: { width: number; height: number; format: "png" };
  readonly pacing: { spacingMs: number };

  // Startup validation: anything that makes the provider unusable (e.g. a daemon that
  // cannot read the cache dir). Null when fine.
  configError(): string | null;

  targetForSessionKey(sessionKey: string): TargetRef | null;
  sessionKeyFor(ref: TargetRef): string | null;
  profile(): ProviderProfile | null;

  listTargets(): Promise<ListResult>;
  resolve(ref: TargetRef, opts?: { minRefreshMs?: number }): Promise<ResolveResult>;

  // The only side-effecting call. Returns a classified result and never throws.
  apply(target: { ref: TargetRef; realId: string }, assetPath: string): Promise<ApplyResult>;

  // lower → real id map for status, and seeding after a restart.
  knownIds?(): Record<string, string>;
  seedIds?(map: Record<string, string>): void;
}

export function targetKey(ref: TargetRef): string {
  return `${ref.kind}:${ref.idLower}`;
}

export function parseTargetKey(key: string): TargetRef | null {
  const m = /^(group|profile):(.+)$/.exec(key);
  return m ? { kind: m[1] as TargetKind, idLower: m[2] as string } : null;
}
