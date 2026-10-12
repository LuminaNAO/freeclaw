import path from "node:path";
import type { Clock } from "./clock.js";
import type { CoreFs } from "./fsio.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export type LeaseRecord = { instanceId: string; pid: number; host: string; heartbeatAt: number };

// Cross-process writer lease. A holder that cannot get it goes to standby; it never exits.
export function createLease({
  fs,
  stateDir,
  clock,
  ttlMs,
  instanceId,
  host,
  pid = process.pid,
  isAlive = pidAlive,
}: {
  fs: CoreFs;
  stateDir: string;
  clock: Clock;
  ttlMs: number;
  instanceId: string;
  host: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
}) {
  const file = path.join(stateDir, "writer.lease");
  const me = (): LeaseRecord => ({ instanceId, pid, host, heartbeatAt: clock.now() });

  async function read(): Promise<LeaseRecord | null> {
    try {
      return JSON.parse(await fs.readText(file)) as LeaseRecord;
    } catch {
      return null;
    }
  }

  function stale(l: LeaseRecord | null): boolean {
    if (!l || typeof l.heartbeatAt !== "number") return true;
    if (clock.now() - l.heartbeatAt > ttlMs) return true;
    return l.host === host && typeof l.pid === "number" && l.pid !== pid && !isAlive(l.pid);
  }

  return {
    file,
    read,
    // Returns { held, holder }.
    async acquire(): Promise<{ held: boolean; holder: LeaseRecord | null }> {
      await fs.mkdirp(stateDir);
      const cur = await read();
      if (cur?.instanceId === instanceId) {
        await fs.writeAtomic(file, JSON.stringify(me()));
        return { held: true, holder: me() };
      }
      if (cur && !stale(cur)) return { held: false, holder: cur };
      const tmp = `${file}.${instanceId}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(me()));
      try {
        if (!cur) {
          try {
            await fs.link(tmp, file); // exclusive create
          } catch {
            return { held: false, holder: await read() };
          }
        } else {
          await fs.rename(tmp, file);
        }
      } finally {
        await fs.unlink(tmp);
      }
      const after = await read();
      return after?.instanceId === instanceId
        ? { held: true, holder: after }
        : { held: false, holder: after };
    },
    async stillMine(): Promise<boolean> {
      const cur = await read();
      return cur?.instanceId === instanceId;
    },
    async release(): Promise<void> {
      if (await this.stillMine()) await fs.unlink(file);
    },
  };
}

export type Lease = ReturnType<typeof createLease>;
