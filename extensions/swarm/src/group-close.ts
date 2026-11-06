import { HOLON_KEY_SEPARATOR } from "./contract.js";
import type { TaskStatus } from "./store.js";

// Group self-destruct (ARCH §10c): the channel-side steps every channel plugin shares. A holon's
// group is closed the way an airlock ceremony group is: farewell, rename, remove every other
// member (joined or pending), leave and delete, verify. Each step is attempted even when an
// earlier one failed; the result names every step that failed. The engine side (events, retry,
// resume, BLOCKED) is MemberChannels.closeGroup in members.ts.

/** ARCH §10c.2 a-e, in order. */
export const GROUP_CLOSE_STEPS = ["farewell", "rename", "remove", "quit", "verify"] as const;
export type GroupCloseStep = (typeof GROUP_CLOSE_STEPS)[number];

export type GroupCloseOptions = {
  /** The new name: `<name> [done]` (or `[failed]` / `[cancelled]`). */
  name: string;
  /** The one farewell line (ARCH §10c.2a). */
  farewell: string;
  /** Steps a previous try already did; they are not repeated. `verify` always runs. */
  skip?: readonly GroupCloseStep[];
  /**
   * A retry: when the channel no longer lists the group, steps a-d are moot (the agent is not
   * in it any more) and only verify is recorded.
   */
  retry?: boolean;
};

export type GroupCloseResult = {
  /** Steps that succeeded in this try (skipped steps are not listed). */
  ok: GroupCloseStep[];
  /**
   * Steps that failed in this try, in order. Empty = the group is gone. `channel` = the
   * holon's channel is not configured or threw before any step ran.
   */
  failures: Array<{ step: GroupCloseStep | "channel"; error: string }>;
  /** How many other members (joined or pending) the remove step removed in this try. */
  removed: number;
};

/** The primitives one channel provides; `runGroupClose` calls them in the ARCH order. */
export type GroupCloseOps = {
  post(text: string): Promise<unknown>;
  rename(name: string): Promise<unknown>;
  /** Every other member, joined or pending: everyone except the agent identity. */
  others(): Promise<string[]>;
  /** One remove call for all of them. */
  remove(ids: string[]): Promise<unknown>;
  /** Leave and delete the group locally (Signal: `quitGroup { delete: true }`). */
  quitAndDelete(): Promise<unknown>;
  /** Whether the channel still lists the group. */
  listed(): Promise<boolean>;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ARCH §10c.2: every step in order, each attempted even if an earlier one failed. */
export async function runGroupClose(
  ops: GroupCloseOps,
  opts: GroupCloseOptions,
): Promise<GroupCloseResult> {
  const skip = new Set(opts.skip ?? []);
  const result: GroupCloseResult = { ok: [], failures: [], removed: 0 };
  if (opts.retry) {
    const listed = await ops.listed().catch(() => true);
    if (!listed) {
      result.ok.push("verify");
      return result;
    }
  }
  const step = async (name: GroupCloseStep, fn: () => Promise<unknown>) => {
    if (name !== "verify" && skip.has(name)) {
      return;
    }
    try {
      await fn();
      result.ok.push(name);
    } catch (err) {
      result.failures.push({ step: name, error: errorText(err) });
    }
  };
  await step("farewell", () => ops.post(opts.farewell));
  await step("rename", () => ops.rename(opts.name));
  await step("remove", async () => {
    const others = [...new Set(await ops.others())];
    if (others.length > 0) {
      await ops.remove(others);
    }
    result.removed = others.length;
  });
  // Never needs a new admin: after the remove step the agent is alone in the group.
  await step("quit", () => ops.quitAndDelete());
  await step("verify", async () => {
    if (await ops.listed()) {
      throw new Error("the group is still listed after quitGroup");
    }
  });
  return result;
}

export type ClosedState = Exclude<TaskStatus, "open">;

/** ARCH §10c.2a. */
export function farewellLine(holonId: string, state: ClosedState): string {
  return `Task ${holonId} is ${state}. This group will now self-destruct; you can safely delete it.`;
}

/** ARCH §10c.2b: `<name> [done]` (or `[failed]` / `[cancelled]`). */
export function closedGroupName(name: string, state: ClosedState): string {
  return `${name} [${state}]`;
}

/** A holon's own id (the last segment of its path from the root). */
export function holonIdOf(taskId: string): string {
  return taskId.slice(taskId.lastIndexOf(HOLON_KEY_SEPARATOR) + 1);
}

/** ARCH §10c.3: at most 10 tries, then `BLOCKED: group not destroyed` one level up. */
export const GROUP_CLOSE_MAX_TRIES = 10;
export const GROUP_CLOSE_FIRST_DELAY_MS = 60_000;
export const GROUP_CLOSE_MAX_DELAY_MS = 30 * 60_000;
/** The timer key of a holon's group-close retry (one per holon, beside the role retries). */
export const GROUP_CLOSE_TIMER = "group-close";

/** ARCH §10c.3: the wait after failed try `attempt`: 1 min doubling to 30 min. */
export function groupCloseDelayMs(attempt: number): number {
  return Math.min(
    GROUP_CLOSE_FIRST_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    GROUP_CLOSE_MAX_DELAY_MS,
  );
}

/** Steps listed in an event's data, in ARCH order (unknown names dropped). */
export function stepsOf(value: unknown): GroupCloseStep[] {
  const names = new Set(Array.isArray(value) ? value.map(String) : []);
  return GROUP_CLOSE_STEPS.filter((s) => names.has(s));
}

/**
 * What a retry skips, from the steps earlier tries did: a farewell is never posted twice and a
 * done rename is not repeated. Remove and leave-and-delete run again while the group is listed
 * (someone may have joined since; the agent is still in it). A group already gone is caught by
 * the retry check in `runGroupClose`.
 */
export function skipAfter(done: readonly GroupCloseStep[]): GroupCloseStep[] {
  return done.filter((s) => s === "farewell" || s === "rename");
}
