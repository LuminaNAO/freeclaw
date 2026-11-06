import {
  runGroupClose,
  type GroupCloseOptions,
  type GroupCloseResult,
  type GroupCloseStep,
} from "./group-close.js";
import type { HolonChannel } from "./members.js";

// Fake loopback channel (ARCH §10a.4, §10c.5): an in-memory group API for tests and dry runs. It
// never leaves the process: no daemon, no network, no real group, nobody is messaged. A test
// plays the members by calling `reply`, which feeds the same inbound function a real channel's
// message hook calls. Like a real Signal group, the agent is the group's only admin, and an
// admin cannot leave while other members remain (the last-admin rule behind ARCH §10c).

export type FakeGroup = {
  groupId: string;
  name: string;
  /** Joined members other than the agent identity. */
  members: string[];
  /** Invited members who have not joined yet (ARCH §10c.2c: removed too). */
  pending: string[];
  /** Lines the swarm posted, in order. */
  posts: string[];
  /** The agent left the group (nothing can be posted any more). */
  closed: boolean;
  /** The group is gone from the agent's list (left and deleted). */
  deleted: boolean;
};

export type FakeInbound = (msg: {
  channel: string;
  groupId: string;
  who: string;
  text: string;
}) => Promise<unknown>;

/** One call the swarm made on a fake group, in order (ARCH §10c.5 checks the sequence). */
export type FakeCall =
  | { op: "post"; groupId: string; text: string }
  | { op: "rename"; groupId: string; name: string }
  | { op: "removeMember"; groupId: string; members: string[] }
  | { op: "quitGroup"; groupId: string; delete: boolean }
  | { op: "listGroups"; detailed: boolean };

type FailKey = "createGroup" | "post" | "closeGroup" | GroupCloseStep;

export class FakeChannel implements HolonChannel {
  readonly kind: string;
  readonly groups = new Map<string, FakeGroup>();
  /** Every group call, in order. */
  readonly calls: FakeCall[] = [];
  /** Set by the test (or index wiring) to the swarm's inbound function. */
  inbound?: FakeInbound;
  /**
   * Make the next N calls of a method or close step fail, to test "no channel", resume and the
   * §10c.5 single-step failures. `verify` failing means the group is still listed after the
   * quit (as when a quit is refused silently); every other key throws.
   */
  failNext: Partial<Record<FailKey, number>> = {};

  constructor(kind = "fake") {
    this.kind = kind;
  }

  private takeFail(key: FailKey): boolean {
    const left = this.failNext[key] ?? 0;
    if (left > 0) {
      this.failNext[key] = left - 1;
      return true;
    }
    return false;
  }

  private maybeFail(key: FailKey): void {
    if (this.takeFail(key)) {
      throw new Error(`fake ${key} failed`);
    }
  }

  private group(groupId: string): FakeGroup {
    const group = this.groups.get(groupId);
    if (!group || group.deleted) {
      throw new Error(`fake group ${groupId} does not exist`);
    }
    return group;
  }

  async createGroup(opts: { name: string; members: string[] }): Promise<{ groupId: string }> {
    this.maybeFail("createGroup");
    const groupId = `fake-group-${this.groups.size + 1}`;
    this.groups.set(groupId, {
      groupId,
      name: opts.name,
      members: [...opts.members],
      pending: [],
      posts: [],
      closed: false,
      deleted: false,
    });
    return { groupId };
  }

  async post(groupId: string, text: string): Promise<void> {
    this.maybeFail("post");
    const group = this.groups.get(groupId);
    if (!group || group.closed) {
      throw new Error(`fake group ${groupId} is not open`);
    }
    this.calls.push({ op: "post", groupId, text });
    group.posts.push(text);
  }

  /** ARCH §10c: the shared step runner over this group's primitives. */
  async closeGroup(groupId: string, opts: GroupCloseOptions): Promise<GroupCloseResult> {
    this.maybeFail("closeGroup");
    let ghost = false;
    return runGroupClose(
      {
        post: async (text) => {
          this.maybeFail("farewell");
          await this.post(groupId, text);
        },
        rename: async (name) => {
          this.maybeFail("rename");
          const group = this.group(groupId);
          if (group.closed) {
            throw new Error(`fake group ${groupId}: not a member`);
          }
          this.calls.push({ op: "rename", groupId, name });
          group.name = name;
        },
        others: async () => {
          this.calls.push({ op: "listGroups", detailed: true });
          const group = this.group(groupId);
          return [...group.members, ...group.pending];
        },
        remove: async (ids) => {
          this.maybeFail("remove");
          const group = this.group(groupId);
          this.calls.push({ op: "removeMember", groupId, members: [...ids] });
          group.members = group.members.filter((m) => !ids.includes(m));
          group.pending = group.pending.filter((m) => !ids.includes(m));
        },
        quitAndDelete: async () => {
          this.maybeFail("quit");
          const group = this.group(groupId);
          this.calls.push({ op: "quitGroup", groupId, delete: true });
          if (!group.closed && group.members.length + group.pending.length > 0) {
            // Signal refuses a plain quit by the last admin while others remain.
            throw new Error("fake quitGroup refused: the agent is the group's last admin");
          }
          group.closed = true;
          group.deleted = true;
        },
        listed: async () => {
          this.calls.push({ op: "listGroups", detailed: false });
          if (this.takeFail("verify")) {
            ghost = true;
          }
          const group = this.groups.get(groupId);
          return ghost || Boolean(group && !group.deleted);
        },
      },
      opts,
    );
  }

  /** Invite someone who has not joined yet (a pending member). */
  invite(groupId: string, who: string): void {
    this.group(groupId).pending.push(who);
  }

  /** Whether the agent's group list still contains the group. */
  listed(groupId: string): boolean {
    const group = this.groups.get(groupId);
    return Boolean(group && !group.deleted);
  }

  /** A member writes in a group (loopback inbound). */
  async reply(groupId: string, who: string, text: string): Promise<unknown> {
    if (!this.inbound) {
      throw new Error("fake channel has no inbound handler");
    }
    return this.inbound({ channel: this.kind, groupId, who, text });
  }

  /** Every line posted to the only (or the given) group. */
  postsOf(groupId?: string): string[] {
    const group = groupId ? this.groups.get(groupId) : [...this.groups.values()][0];
    return group?.posts ?? [];
  }
}
