// The swarm's own timers (ARCH §7.1.4, §7.1.5): the scheduled retry after a run error and the
// idle sweep. Principle 1 "no timers" is amended for these two only; nothing else arms one.

export type SwarmClock = {
  now: () => number;
  setTimeout: (fn: () => unknown, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const systemClock: SwarmClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A pending retry never keeps the process alive on its own.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One retry timer per (holon, role) and one sweep loop. */
export class SwarmTimers {
  private readonly retries = new Map<string, unknown>();
  private sweep?: unknown;
  private sweeping = false;

  constructor(readonly clock: SwarmClock) {}

  private static key(taskId: string, role: string): string {
    return `${taskId}\u0000${role}`;
  }

  /** Arm (or re-arm) the retry for a role; it fires at `at` (epoch ms), or now if past. */
  armRetry(taskId: string, role: string, at: number, fire: () => unknown): void {
    const key = SwarmTimers.key(taskId, role);
    this.cancelRetry(taskId, role);
    const handle = this.clock.setTimeout(
      () => {
        if (this.retries.get(key) === handle) {
          this.retries.delete(key);
        }
        return fire();
      },
      Math.max(0, at - this.clock.now()),
    );
    this.retries.set(key, handle);
  }

  hasRetry(taskId: string, role: string): boolean {
    return this.retries.has(SwarmTimers.key(taskId, role));
  }

  cancelRetry(taskId: string, role: string): void {
    const key = SwarmTimers.key(taskId, role);
    const handle = this.retries.get(key);
    if (handle !== undefined) {
      this.clock.clearTimeout(handle);
      this.retries.delete(key);
    }
  }

  /** Every retry of a closed holon is dropped. */
  cancelTask(taskId: string): void {
    const prefix = `${taskId}\u0000`;
    for (const [key, handle] of this.retries) {
      if (key.startsWith(prefix)) {
        this.clock.clearTimeout(handle);
        this.retries.delete(key);
      }
    }
  }

  /** ARCH §7.1.5: run `tick` every `everyMs`, one at a time, until stopped. */
  startSweep(everyMs: number, tick: () => Promise<unknown>): void {
    this.stopSweep();
    this.sweeping = true;
    const loop = () => {
      this.sweep = this.clock.setTimeout(async () => {
        try {
          await tick();
        } finally {
          if (this.sweeping) {
            loop();
          }
        }
      }, everyMs);
    };
    loop();
  }

  stopSweep(): void {
    this.sweeping = false;
    if (this.sweep !== undefined) {
      this.clock.clearTimeout(this.sweep);
      this.sweep = undefined;
    }
  }

  stopAll(): void {
    this.stopSweep();
    for (const handle of this.retries.values()) {
      this.clock.clearTimeout(handle);
    }
    this.retries.clear();
  }
}
