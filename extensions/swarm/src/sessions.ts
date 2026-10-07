import { TASK_ID_RE } from "./contract.js";
import { TASKMASTER } from "./routing.js";

// Session keys (ARCH §1.2): agent:<agentId>:swarm:<task-id>:<role>.

export const DEFAULT_AGENT_ID = "main";
const SWARM_MARKER = ":swarm:";

export function sessionKeyFor(taskId: string, role: string, agentId = DEFAULT_AGENT_ID): string {
  return `agent:${agentId}:swarm:${taskId}:${role}`;
}

export type SwarmSessionRef = { agentId: string; taskId: string; role: string };

/** Cheap prefix test so hooks can return before any I/O for non-swarm sessions. */
export function isSwarmSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(SWARM_MARKER);
}

export function parseSwarmSessionKey(sessionKey: string | undefined): SwarmSessionRef | null {
  if (!isSwarmSessionKey(sessionKey)) {
    return null;
  }
  const parts = (sessionKey ?? "").trim().toLowerCase().split(":");
  if (parts.length !== 5 || parts[0] !== "agent" || parts[2] !== "swarm") {
    return null;
  }
  const [, agentId, , taskId, role] = parts;
  if (!agentId || !taskId || !role || !TASK_ID_RE.test(taskId)) {
    return null;
  }
  return { agentId, taskId, role };
}

export function isTaskmasterRole(role: string): boolean {
  return role === TASKMASTER;
}
