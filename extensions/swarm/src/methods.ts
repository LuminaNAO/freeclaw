import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/swarm";
import { continueTask } from "./continue.js";
import type { SwarmEngine } from "./engine.js";
import { answerTask, cancelTask, listTasks, showTask, startTask } from "./tasks.js";

// Gateway methods swarm.start / list / show / cancel / answer (ARCH §5, §9) and
// swarm.continue (ARCH §12).

type Handler = (opts: GatewayRequestHandlerOptions) => Promise<void>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Gateway clients read the error text from the third respond() argument, not the payload;
 * without it callers only see "unknown error". The payload copy keeps --json output useful.
 */
function fail(
  respond: GatewayRequestHandlerOptions["respond"],
  code: "INVALID_REQUEST" | "UNAVAILABLE",
  message: string,
) {
  respond(false, { error: message }, { code, message });
}

function str(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createSwarmMethods(
  getEngine: () => SwarmEngine | undefined,
): Record<string, Handler> {
  const guarded =
    (
      fn: (engine: SwarmEngine, params: Record<string, unknown>) => Promise<unknown> | unknown,
    ): Handler =>
    async ({ params, respond }) => {
      const engine = getEngine();
      if (!engine) {
        fail(respond, "UNAVAILABLE", "swarm plugin is not started");
        return;
      }
      try {
        respond(true, await fn(engine, params ?? {}));
      } catch (err) {
        fail(respond, "INVALID_REQUEST", errorMessage(err));
      }
    };

  return {
    "swarm.start": guarded((engine, params) => {
      const contractYaml = str(params, "contract");
      const contractPath = str(params, "file");
      if (!contractYaml && !contractPath) {
        throw new Error("swarm.start needs `file` (contract path) or `contract` (YAML text)");
      }
      // A relative path would resolve against the gateway's cwd, not the caller's (change 2).
      if (!contractYaml && contractPath && !path.isAbsolute(contractPath)) {
        throw new Error(
          `swarm.start \`file\` must be an absolute path (got "${contractPath}"); resolve it in the caller`,
        );
      }
      return startTask(engine, { contractYaml, contractPath });
    }),
    "swarm.continue": guarded((engine, params) => {
      const taskId = str(params, "taskId");
      const followUpYaml = str(params, "followup");
      const followUpPath = str(params, "file");
      if (!taskId || (!followUpYaml && !followUpPath)) {
        throw new Error(
          "swarm.continue needs `taskId` and `file` (follow-up path) or `followup` (YAML text)",
        );
      }
      // Same rule as swarm.start: the caller resolves a relative path, never the gateway.
      if (!followUpYaml && followUpPath && !path.isAbsolute(followUpPath)) {
        throw new Error(
          `swarm.continue \`file\` must be an absolute path (got "${followUpPath}"); resolve it in the caller`,
        );
      }
      return continueTask(engine, taskId, { followUpYaml, followUpPath });
    }),
    "swarm.list": guarded((engine) => ({ tasks: listTasks(engine.stateDir) })),
    "swarm.show": guarded((engine, params) => {
      const taskId = str(params, "taskId");
      if (!taskId) {
        throw new Error("swarm.show needs `taskId`");
      }
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      return showTask(engine, taskId, limit);
    }),
    "swarm.cancel": guarded((engine, params) => {
      const taskId = str(params, "taskId");
      if (!taskId) {
        throw new Error("swarm.cancel needs `taskId`");
      }
      return cancelTask(engine, taskId, str(params, "reason"));
    }),
    "swarm.answer": guarded((engine, params) => {
      const taskId = str(params, "taskId");
      const message = str(params, "message");
      if (!taskId || !message) {
        throw new Error("swarm.answer needs `taskId` and `message`");
      }
      return answerTask(engine, taskId, message);
    }),
  };
}
