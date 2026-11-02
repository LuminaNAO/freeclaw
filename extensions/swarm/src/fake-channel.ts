import type { HolonChannel } from "./humans.js";

// Fake loopback channel (ARCH §10a.4): an in-memory group API for tests and dry runs. It never
// leaves the process: no daemon, no network, no real group, nobody is messaged. A test plays
// the humans by calling `reply`, which feeds the same inbound function a real channel's
// message hook calls.

export type FakeGroup = {
  groupId: string;
  name: string;
  members: string[];
  /** Lines the swarm posted, in order. */
  posts: string[];
  closed: boolean;
};

export type FakeInbound = (msg: {
  channel: string;
  groupId: string;
  who: string;
  text: string;
}) => Promise<unknown>;

export class FakeChannel implements HolonChannel {
  readonly kind: string;
  readonly groups = new Map<string, FakeGroup>();
  /** Set by the test (or index wiring) to the swarm's inbound function. */
  inbound?: FakeInbound;
  /** Make the next N calls of a method fail, to test "no channel" and resume paths. */
  failNext: Partial<Record<"createGroup" | "post" | "closeGroup", number>> = {};

  constructor(kind = "fake") {
    this.kind = kind;
  }

  private maybeFail(method: "createGroup" | "post" | "closeGroup"): void {
    const left = this.failNext[method] ?? 0;
    if (left > 0) {
      this.failNext[method] = left - 1;
      throw new Error(`fake ${method} failed`);
    }
  }

  async createGroup(opts: { name: string; members: string[] }): Promise<{ groupId: string }> {
    this.maybeFail("createGroup");
    const groupId = `fake-group-${this.groups.size + 1}`;
    this.groups.set(groupId, {
      groupId,
      name: opts.name,
      members: [...opts.members],
      posts: [],
      closed: false,
    });
    return { groupId };
  }

  async post(groupId: string, text: string): Promise<void> {
    this.maybeFail("post");
    const group = this.groups.get(groupId);
    if (!group || group.closed) {
      throw new Error(`fake group ${groupId} is not open`);
    }
    group.posts.push(text);
  }

  async closeGroup(groupId: string, opts: { name: string }): Promise<void> {
    this.maybeFail("closeGroup");
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`fake group ${groupId} does not exist`);
    }
    group.name = opts.name;
    group.closed = true;
  }

  /** A human writes in a group (loopback inbound). */
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
