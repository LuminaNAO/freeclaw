import { describe, expect, it } from "vitest";
import {
  acceptPendingGroupInvites,
  isPendingGroupInviteForAci,
  resolveGroupInviteSender,
} from "./group-invites.js";

const OWN_ACI = "11111111-2222-3333-4444-555555555555";
const ALLOWED_UUID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const ALLOWED_NUMBER = "+10000000001";
const STRANGER_UUID = "cccccccc-1111-2222-3333-dddddddddddd";

/** Real signal-cli listGroups entry shape (ListGroupsCommand.JsonGroup). */
function realGroupEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "dGVzdC1ncm91cC1pZA==",
    name: "Ops",
    description: null,
    isMember: false,
    isBlocked: false,
    isTerminated: false,
    messageExpirationTime: 0,
    members: [],
    pendingMembers: [],
    requestingMembers: [],
    admins: [],
    banned: [],
    permissionAddMember: "EVERY_MEMBER",
    permissionEditDetails: "ONLY_ADMIN",
    permissionSendMessage: "EVERY_MEMBER",
    groupInviteLink: null,
    ...overrides,
  };
}

describe("isPendingGroupInviteForAci (real signal-cli listGroups shape)", () => {
  it("is true when we are not a member and our ACI is in pendingMembers", () => {
    const group = realGroupEntry({
      pendingMembers: [{ number: null, uuid: OWN_ACI }],
    });
    expect(isPendingGroupInviteForAci(group, OWN_ACI)).toBe(true);
  });

  it("is false when we are already a member", () => {
    const group = realGroupEntry({
      isMember: true,
      members: [{ number: "+15550001234", uuid: OWN_ACI }],
      pendingMembers: [{ number: null, uuid: OWN_ACI }],
    });
    expect(isPendingGroupInviteForAci(group, OWN_ACI)).toBe(false);
  });

  it("is false when our ACI is not pending (invite addressed elsewhere)", () => {
    const group = realGroupEntry({
      pendingMembers: [{ number: "+19999999999", uuid: STRANGER_UUID }],
    });
    expect(isPendingGroupInviteForAci(group, OWN_ACI)).toBe(false);
  });

  it("is false for a group with no pending members and for terminated groups", () => {
    expect(isPendingGroupInviteForAci(realGroupEntry(), OWN_ACI)).toBe(false);
    expect(
      isPendingGroupInviteForAci(
        realGroupEntry({ isTerminated: true, pendingMembers: [{ uuid: OWN_ACI }] }),
        OWN_ACI,
      ),
    ).toBe(false);
  });

  it("matches the ACI case-insensitively", () => {
    const group = realGroupEntry({ pendingMembers: [{ uuid: OWN_ACI.toUpperCase() }] });
    expect(isPendingGroupInviteForAci(group, OWN_ACI)).toBe(true);
  });
});

describe("acceptPendingGroupInvites (fresh-install ARCH §1.4)", () => {
  const baseParams = {
    baseUrl: "unix:/nonexistent.sock",
    account: "+15550001234",
    accountUuid: OWN_ACI,
    groupAllowFrom: [`uuid:${ALLOWED_UUID}`, ALLOWED_NUMBER],
  };

  it("accepts a pending invite for our ACI when the inviter is allowed, via updateGroup", async () => {
    const accepted: string[] = [];
    const logs: string[] = [];
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      log: (m) => logs.push(m),
      listGroupsFn: async () => [
        realGroupEntry({
          id: "group-1",
          pendingMembers: [{ number: null, uuid: OWN_ACI }],
          invitedByUuid: ALLOWED_UUID,
        }),
      ],
      acceptInviteFn: async (groupId) => {
        accepted.push(groupId);
        return {};
      },
    });
    expect(accepted).toEqual(["group-1"]);
    expect(summary.accepted).toEqual([
      { groupId: "group-1", name: "Ops", inviter: `uuid:${ALLOWED_UUID}` },
    ]);
    expect(summary.leftPending).toEqual([]);
    expect(logs.join("\n")).toContain("accepted group invite");
  });

  it("accepts an invite from an allowed inviter (phone number)", async () => {
    const accepted: string[] = [];
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      listGroupsFn: async () => [
        realGroupEntry({
          id: "group-2",
          pendingMembers: [{ uuid: OWN_ACI }],
          invitedByNumber: ALLOWED_NUMBER,
        }),
      ],
      acceptInviteFn: async (groupId) => {
        accepted.push(groupId);
        return {};
      },
    });
    expect(accepted).toEqual(["group-2"]);
    expect(summary.accepted[0]?.inviter).toBe(ALLOWED_NUMBER);
  });

  it("leaves an invite pending when the inviter is not in groupAllowFrom", async () => {
    const accepted: string[] = [];
    const logs: string[] = [];
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      log: (m) => logs.push(m),
      listGroupsFn: async () => [
        realGroupEntry({
          id: "group-3",
          name: "Shady",
          pendingMembers: [{ uuid: OWN_ACI }],
          invitedByUuid: STRANGER_UUID,
        }),
      ],
      acceptInviteFn: async (groupId) => {
        accepted.push(groupId);
        return {};
      },
    });
    expect(accepted).toEqual([]);
    expect(summary.accepted).toEqual([]);
    expect(summary.leftPending).toEqual([
      { groupId: "group-3", name: "Shady", inviter: `uuid:${STRANGER_UUID}` },
    ]);
    expect(logs.join("\n")).toContain("leaving group invite");
    expect(logs.join("\n")).toContain("not in groupAllowFrom");
  });

  it("leaves an invite pending when the inviter is unknown (real listGroups has no inviter)", async () => {
    const accepted: string[] = [];
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      listGroupsFn: async () => [
        realGroupEntry({ id: "group-4", pendingMembers: [{ uuid: OWN_ACI }] }),
      ],
      acceptInviteFn: async (groupId) => {
        accepted.push(groupId);
        return {};
      },
    });
    expect(accepted).toEqual([]);
    expect(summary.leftPending[0]?.groupId).toBe("group-4");
    expect(summary.leftPending[0]?.inviter).toBeUndefined();
  });

  it("a resolveInviter override can opt a group in when a better inviter source exists", async () => {
    const accepted: string[] = [];
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      resolveInviter: () => ({ kind: "uuid", raw: ALLOWED_UUID }),
      listGroupsFn: async () => [
        realGroupEntry({ id: "group-5", pendingMembers: [{ uuid: OWN_ACI }] }),
      ],
      acceptInviteFn: async (groupId) => {
        accepted.push(groupId);
        return {};
      },
    });
    expect(accepted).toEqual(["group-5"]);
    expect(summary.accepted).toHaveLength(1);
  });

  it("ignores groups we are already a member of and groups not addressed to our ACI", async () => {
    const accepted: string[] = [];
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      listGroupsFn: async () => [
        realGroupEntry({ id: "member", isMember: true, invitedByUuid: ALLOWED_UUID }),
        realGroupEntry({ id: "someone-else", pendingMembers: [{ uuid: STRANGER_UUID }] }),
      ],
      acceptInviteFn: async (groupId) => {
        accepted.push(groupId);
        return {};
      },
    });
    expect(accepted).toEqual([]);
    expect(summary.accepted).toEqual([]);
    expect(summary.leftPending).toEqual([]);
  });

  it("does nothing when accountUuid is missing and says why", async () => {
    const logs: string[] = [];
    let listed = false;
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      accountUuid: undefined,
      log: (m) => logs.push(m),
      listGroupsFn: async () => {
        listed = true;
        return [];
      },
    });
    expect(listed).toBe(false);
    expect(summary.accepted).toEqual([]);
    expect(logs.join("\n")).toContain("accountUuid");
  });

  it("records accept failures without aborting the rest", async () => {
    const accepted: string[] = [];
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      listGroupsFn: async () => [
        realGroupEntry({
          id: "group-7",
          pendingMembers: [{ uuid: OWN_ACI }],
          invitedByUuid: ALLOWED_UUID,
        }),
        realGroupEntry({
          id: "group-8",
          pendingMembers: [{ uuid: OWN_ACI }],
          invitedByUuid: ALLOWED_UUID,
        }),
      ],
      acceptInviteFn: async (groupId) => {
        if (groupId === "group-7") {
          throw new Error("boom");
        }
        accepted.push(groupId);
        return {};
      },
    });
    expect(summary.errors).toEqual([{ groupId: "group-7", error: "Error: boom" }]);
    expect(accepted).toEqual(["group-8"]);
  });

  it("handles a non-array listGroups result defensively", async () => {
    const summary = await acceptPendingGroupInvites({
      ...baseParams,
      listGroupsFn: async () => ({ unexpected: true }),
    });
    expect(summary.accepted).toEqual([]);
    expect(summary.leftPending).toEqual([]);
  });
});

describe("resolveGroupInviteSender", () => {
  it("prefers explicit inviter number/uuid fields when present", () => {
    expect(resolveGroupInviteSender({ id: "g1", invitedByNumber: "+10000000001" })).toEqual({
      kind: "phone",
      raw: "+10000000001",
      e164: "+10000000001",
    });
    expect(resolveGroupInviteSender({ id: "g1", invitedByUuid: ALLOWED_UUID })).toEqual({
      kind: "uuid",
      raw: ALLOWED_UUID,
    });
    expect(resolveGroupInviteSender({ id: "g1" })).toBeNull();
  });
});
