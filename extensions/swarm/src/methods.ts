import fs from "node:fs";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/swarm";
import { spawnChild } from "./children.js";
import { continueTask } from "./continue.js";
import type { SwarmEngine } from "./engine.js";
// §10a.3 (humans over a channel): group lifecycle and the relay's inbound reply.
import { closeHolonGroup, openHolonGroup } from "./humans.js";
import { OPERATOR_CALLER, runOp, SWARM_OPS } from "./ops.js";
import { relayHumanReply } from "./relay.js";
import { answerTask, cancelTask, listTasks, startTask } from "./tasks.js";

// Gateway methods swarm.start / list / show / cancel / answer (ARCH §5, §9),
// swarm.continue (ARCH §12) and swarm.spawn (ARCH §5, §10a.1). The steps 3-5 ops
// (ARCH §10a: add, lead, show --tree, …) are one gateway method per SWARM_OPS row,
// dispatched through runOp: the same function the lead tool calls. A gateway client is
// the operator (the root owner, §3.4).

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
    "swarm.cancel": guarded((engine, params) => {
      const taskId = str(params, "taskId");
      if (!taskId) {
        throw new Error("swarm.cancel needs `taskId`");
      }
      return cancelTask(engine, taskId, str(params, "reason"));
    }),
    // ARCH §5, §10a.1: spawn a child holon under a parent (the lead tool calls the same op).
    "swarm.spawn": guarded((engine, params) => {
      const parent = str(params, "parent");
      const holonYaml = str(params, "holon");
      const holonPath = str(params, "file");
      if (!parent || (!holonYaml && !holonPath)) {
        throw new Error(
          "swarm.spawn needs `parent` and `file` (holon path) or `holon` (YAML text)",
        );
      }
      if (!holonYaml && holonPath && !path.isAbsolute(holonPath)) {
        throw new Error(
          `swarm.spawn \`file\` must be an absolute path (got "${holonPath}"); resolve it in the caller`,
        );
      }
      return spawnChild(engine, parent, holonYaml ?? fs.readFileSync(holonPath!, "utf8"));
    }),
    "swarm.answer": guarded((engine, params) => {
      const taskId = str(params, "taskId");
      const message = str(params, "message");
      if (!taskId || !message) {
        throw new Error("swarm.answer needs `taskId` and `message`");
      }
      return answerTask(engine, taskId, message);
    }),
    // ARCH §10a: every op in the table, through the shared dispatch.
    ...Object.fromEntries(
      Object.entries(SWARM_OPS).map(([name, op]) => [
        op.method,
        guarded((engine, params) => runOp(name, engine, params, OPERATOR_CALLER)),
      ]),
    ),
    // ARCH §10a.3: the same ops the channel hook and the fake channel call.
    "swarm.group": guarded((engine, params) => {
      const taskId = str(params, "taskId");
      const action = str(params, "action");
      if (!taskId || (action !== "open" && action !== "close")) {
        throw new Error("swarm.group needs `taskId` and `action` (open | close)");
      }
      return action === "open" ? openHolonGroup(engine, taskId) : closeHolonGroup(engine, taskId);
    }),
    "swarm.relay": guarded((engine, params) => {
      const taskId = str(params, "taskId");
      const who = str(params, "who");
      const message = str(params, "message");
      if (!taskId || !who || !message) {
        throw new Error("swarm.relay needs `taskId`, `who` (a human's channel id) and `message`");
      }
      return relayHumanReply(engine, { taskId, who, text: message });
    }),
  };
}
