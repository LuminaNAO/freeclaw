import { signalRpcRequest } from "./client.js";
import {
  formatSignalSenderDisplay,
  isSignalSenderAllowed,
  resolveSignalSender,
  type SignalSender,
} from "./identity.js";

/**
 * fresh-install ARCH §1.4, gateway side: a group invite addressed to the
 * account's phone number cannot be accepted by a linked signal-cli device
 * ("Cannot find service ID for self", observed live). On start, the gateway
 * accepts pending group memberships addressed to its own ACI — but only for
 * groups whose inviter is allowed by groupAllowFrom (the existing access
 * policy decides; invites from anyone else stay pending and are logged).
 *
 * Real signal-cli contract (ListGroupsCommand.JsonGroup): a `listGroups`
 * entry is {id, name, description, isMember, isBlocked, messageExpirationTime,
 * members, pendingMembers, requestingMembers, admins, banned, ...}; members
 * and pendingMembers are {number, uuid} objects. A pending invite addressed
 * to us is `isMember: false` with our ACI in `pendingMembers`. Accepting is
 * `updateGroup` with just the groupId ("If the user is a pending member, this
 * command will accept the group invitation"). The group object carries no
 * inviter identity, so the groupAllowFrom decision needs an inviter source;
 * when none is configured the safe behaviour is to leave everything pending.
 */

export type SignalGroupMember = {
  number?: string | null;
  uuid?: string | null;
};

export type SignalGroupListEntry = {
  id?: string;
  name?: string;
  isMember?: boolean;
  isBlocked?: boolean;
  isTerminated?: boolean;
  members?: SignalGroupMember[];
  pendingMembers?: SignalGroupMember[];
  [key: string]: unknown;
};

/** A group entry is a pending invite for us when we are not a member but our ACI is pending. */
export function isPendingGroupInviteForAci(group: SignalGroupListEntry, ownAci: string): boolean {
  if (group.isMember === true || group.isTerminated === true) {
    return false;
  }
  const aci = ownAci.trim().toLowerCase();
  if (!aci) {
    return false;
  }
  const pending = Array.isArray(group.pendingMembers) ? group.pendingMembers : [];
  return pending.some(
    (member) =>
      Boolean(member) &&
      typeof member === "object" &&
      typeof member.uuid === "string" &&
      member.uuid.trim().toLowerCase() === aci,
  );
}

/**
 * Resolve the inviter of a pending group entry. Real signal-cli listGroups
 * carries no inviter field; this only exists so tests and future signal-cli
 * shapes can supply one explicitly.
 */
export function resolveGroupInviteSender(group: SignalGroupListEntry): SignalSender | null {
  const inviterNumber =
    (typeof group.invitedByNumber === "string" ? group.invitedByNumber.trim() : "") ||
    (typeof group.inviterNumber === "string" ? group.inviterNumber.trim() : "");
  const rawUuid =
    (typeof group.invitedByUuid === "string" ? group.invitedByUuid.trim() : "") ||
    (typeof group.inviterUuid === "string" ? group.inviterUuid.trim() : "") ||
    (typeof group.invitedBy === "string" ? group.invitedBy.trim() : "") ||
    (typeof group.inviter === "string" ? group.inviter.trim() : "");
  const uuidLike = /^[0-9a-f-]{32,36}$/i.test(rawUuid) ? rawUuid : "";
  const numberLike = rawUuid.startsWith("+") ? rawUuid : "";
  return resolveSignalSender({
    sourceNumber: inviterNumber || numberLike || null,
    sourceUuid: uuidLike || null,
  });
}

export type GroupInviteAcceptSummary = {
  accepted: Array<{ groupId: string; name?: string; inviter?: string }>;
  leftPending: Array<{ groupId: string; name?: string; inviter?: string }>;
  errors: Array<{ groupId: string; error: string }>;
};

export async function acceptPendingGroupInvites(params: {
  baseUrl: string;
  account: string;
  /** Own ACI; without it we cannot tell which pending entries are ours. */
  accountUuid?: string;
  /** Account id; scopes the once-per-entry legacy phone allow-list warning (uuid ARCH §3.2). */
  accountId?: string;
  groupAllowFrom: string[];
  /**
   * Resolve the inviter for a pending group. Real signal-cli listGroups has
   * no inviter field; the default resolver finds nothing and every invite
   * stays pending (fail closed, per ARCH: "invites from anyone else stay
   * pending and are logged"). Supplying one is how an operator/agent with a
   * better source (e.g. invite context from the daemon log) can opt a group in.
   */
  resolveInviter?: (group: SignalGroupListEntry) => SignalSender | null;
  log?: (message: string) => void;
  /** Injectable for tests. */
  listGroupsFn?: () => Promise<unknown>;
  /** Injectable for tests; defaults to updateGroup({account, groupId}). */
  acceptInviteFn?: (groupId: string) => Promise<unknown>;
}): Promise<GroupInviteAcceptSummary> {
  const summary: GroupInviteAcceptSummary = { accepted: [], leftPending: [], errors: [] };
  const log = params.log ?? (() => {});
  const accountUuid = params.accountUuid?.trim();
  if (!accountUuid) {
    log(
      "signal: channels.signal.accountUuid is not set; skipping pending group invite acceptance (invite this agent to groups by its uuid)",
    );
    return summary;
  }
  const listGroups =
    params.listGroupsFn ??
    (async () =>
      await signalRpcRequest(
        "listGroups",
        { account: params.account },
        {
          baseUrl: params.baseUrl,
        },
      ));
  // Accepting a pending membership is updateGroup with no other change; the
  // link-based joinGroup (--uri) is a different flow and cannot accept an
  // invite addressed to the account.
  const acceptInvite =
    params.acceptInviteFn ??
    (async (groupId: string) =>
      await signalRpcRequest(
        "updateGroup",
        { account: params.account, groupId },
        { baseUrl: params.baseUrl },
      ));
  const resolveInviter = params.resolveInviter ?? resolveGroupInviteSender;

  let rawGroups: unknown;
  try {
    rawGroups = await listGroups();
  } catch (err) {
    log(`signal: listGroups for group invite acceptance failed: ${String(err)}`);
    return summary;
  }
  // The JSON-RPC listGroups result is a bare array of group entries.
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter(
        (entry): entry is SignalGroupListEntry => Boolean(entry) && typeof entry === "object",
      )
    : [];
  for (const group of groups) {
    if (!isPendingGroupInviteForAci(group, accountUuid)) {
      continue;
    }
    const groupId = typeof group.id === "string" ? group.id.trim() : "";
    if (!groupId) {
      continue;
    }
    const name =
      typeof group.name === "string" && group.name.trim() ? group.name.trim() : undefined;
    const inviter = resolveInviter(group);
    // uuid ARCH §2.4: inviter labels are uuid-first (`uuid:<uuid>`), never the number
    // when a uuid is known.
    const inviterLabel = inviter ? formatSignalSenderDisplay(inviter) : undefined;
    if (
      inviter &&
      isSignalSenderAllowed(inviter, params.groupAllowFrom, {
        accountId: params.accountId,
        warn: log,
      })
    ) {
      try {
        await acceptInvite(groupId);
        log(
          `signal: accepted group invite for ${name ?? groupId} invited by ${inviterLabel ?? "unknown"} (allowed by groupAllowFrom)`,
        );
        summary.accepted.push({ groupId, name, inviter: inviterLabel });
      } catch (err) {
        log(`signal: failed to accept group invite for ${name ?? groupId}: ${String(err)}`);
        summary.errors.push({ groupId, error: String(err) });
      }
      continue;
    }
    log(
      `signal: leaving group invite for ${name ?? groupId} pending (inviter ${inviterLabel ?? "unknown"} is not in groupAllowFrom)`,
    );
    summary.leftPending.push({ groupId, name, inviter: inviterLabel });
  }
  return summary;
}
