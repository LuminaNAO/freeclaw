import { parseDuration } from "./contract.js";
import type { SwarmEngine } from "./engine.js";
import { TASKMASTER } from "./routing.js";
import { readTasksIndex } from "./store.js";

// Wall deadline (ARCH §7 "Taskmaster dies / loses context"): one timer per open task at
// createdAt + budget.wall. It only escalates; it never routes work and never re-prompts.
// There is no step-silence watchdog (ARCH §7).

export type Clock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, Math.min(ms, 2_147_483_647));
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const TASKMASTER_LOST = "TASKMASTER_LOST";

export class WallDeadline {
  private readonly timers = new Map<string, unknown>();

  constructor(
    private readonly engine: SwarmEngine,
    private readonly clock: Clock = realClock,
  ) {}

  /** Arm every open task (service start). */
  armAll(): void {
    for (const [taskId, entry] of Object.entries(readTasksIndex(this.engine.stateDir))) {
      if (entry.status === "open") {
        this.arm(taskId);
      }
    }
  }

  /** Arm one task once; later calls are no-ops while its timer is set. */
  arm(taskId: string): void {
    if (this.timers.has(taskId)) {
      return;
    }
    const entry = readTasksIndex(this.engine.stateDir)[taskId];
    const created = Date.parse(entry?.createdAt ?? "");
    if (entry?.status !== "open" || !Number.isFinite(created)) {
      return;
    }
    let wallMs: number;
    try {
      wallMs = parseDuration(this.engine.loadState(taskId).contract.budget.wall);
    } catch {
      return;
    }
    const delay = Math.max(0, created + wallMs - this.clock.now());
    this.timers.set(
      taskId,
      this.clock.setTimeout(() => void this.fire(taskId), delay),
    );
  }

  stop(): void {
    for (const handle of this.timers.values()) {
      this.clock.clearTimeout(handle);
    }
    this.timers.clear();
  }

  async fire(taskId: string): Promise<void> {
    await this.engine.locks.run(taskId, async () => {
      const state = this.engine.loadState(taskId);
      const reported = state.events.some(
        (e) => (e.kind === "upstream" && e.to === "upstream") || e.event === TASKMASTER_LOST,
      );
      if (state.status !== "open" || reported) {
        return;
      }
      this.engine.record(taskId, {
        kind: "system",
        event: TASKMASTER_LOST,
        sha: state.sha,
      });
      await this.engine.toUpstream(taskId, state, {
        event: "BLOCKED",
        from: TASKMASTER,
        sha: state.sha,
        body: `task exceeded budget.wall (${state.contract.budget.wall}) with no upstream report`,
      });
    });
  }
}
