// ARCH §10b.3: compatibility with the step-5 spelling of members. Old input keeps working and
// nothing on disk is migrated: a holon file with `kind: human`, a `human:<channel>:<who>` lead
// spec and plugin config `humans.*` are read as their member forms, and event logs already
// written with `HUMAN_*` names are read as `MEMBER_*` (resume, show and relay all read through
// `readEvents`). New files and logs only ever say member. This module is the only place in the
// swarm code that knows the old word.

/** The step-5 member kind in holon files and the `swarm lead` short form. */
export const LEGACY_MEMBER_KIND = "human";

/** True for `kind: member` and its §10b.3 alias. */
export function isMemberKind(kind: unknown): boolean {
  return kind === "member" || kind === LEGACY_MEMBER_KIND;
}

/** Old event name → new event name, for logs written before §10b. */
export const LEGACY_EVENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  HUMAN_POSTED: "MEMBER_POSTED",
  HUMAN_POST_FAILED: "MEMBER_POST_FAILED",
  HUMAN_REPLY: "MEMBER_REPLY",
  HUMAN_IGNORED: "MEMBER_IGNORED",
});

/** An event name as the current code knows it (old `HUMAN_*` names read as `MEMBER_*`). */
export function canonicalEventName(event: string): string {
  return LEGACY_EVENT_NAMES[event] ?? event;
}

export type MemberPluginConfig = {
  channels?: Record<string, { accountId?: string }>;
  owners?: Record<string, string[]>;
};

/** ARCH §10b.3: the step-5 plugin config key, still accepted as an alias of `members`. */
export type LegacyMemberConfig = { humans?: MemberPluginConfig };

/**
 * Plugin config `members.*`, with `humans.*` accepted as an alias. When both are given, the
 * member form wins key by key (channels and owners are merged per channel kind).
 */
export function memberConfigOf(
  cfg: { members?: MemberPluginConfig } & LegacyMemberConfig,
): MemberPluginConfig | undefined {
  const legacy = cfg.humans;
  const current = cfg.members;
  if (!legacy) {
    return current;
  }
  if (!current) {
    return legacy;
  }
  return {
    channels: { ...legacy.channels, ...current.channels },
    owners: { ...legacy.owners, ...current.owners },
  };
}
