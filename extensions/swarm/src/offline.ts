import path from "node:path";
import type { SwarmEngine } from "./engine.js";
import { SwarmEngine as Engine } from "./engine.js";
import { createSwarmMethods } from "./methods.js";

// ARCH §9: "Every read works with the gateway down (reads the files)." When the gateway cannot
// be reached, a read verb runs the very same swarm.* handler in-process against the state
// files: no second implementation of list/show. Writes never fall back.

/** Methods that only read the files; the only ones allowed to run without the gateway. */
export const READ_METHODS: ReadonlySet<string> = new Set(["swarm.list", "swarm.show"]);

const UNREACHABLE_RE =
  /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|gateway closed|gateway timeout|socket hang up|connect failed/i;

/** True when an error means the gateway is down or unreachable (not a refused request). */
export function isGatewayUnreachable(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err);
  return UNREACHABLE_RE.test(text);
}

/** A runtime that refuses everything: an offline engine may read but never start a run. */
const OFFLINE_RUNTIME = {
  subagent: {
    run: async () => {
      throw new Error("the gateway is down: offline reads only");
    },
    waitForRun: async () => ({ status: "error" as const, error: "offline" }),
  },
};

/** Read a swarm method's result straight from `<stateDir>/swarm` (gateway down). */
export async function readOffline(
  stateDir: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!READ_METHODS.has(method)) {
    throw new Error(`${method} needs the gateway; only reads work with it down`);
  }
  const engine: SwarmEngine = new Engine({
    stateDir: path.resolve(stateDir),
    runtime: OFFLINE_RUNTIME,
  });
  const handler = createSwarmMethods(() => engine)[method];
  if (!handler) {
    throw new Error(`unknown swarm method ${method}`);
  }
  let out: { ok: boolean; payload: unknown; message?: string } | undefined;
  await handler({
    params,
    respond: (ok: boolean, payload: unknown, error?: { message?: string }) => {
      out = { ok, payload, message: error?.message };
    },
  } as never);
  if (!out?.ok) {
    throw new Error(out?.message ?? "offline read failed");
  }
  return out.payload;
}
