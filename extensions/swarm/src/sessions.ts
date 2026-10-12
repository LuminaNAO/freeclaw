import { TASK_ID_RE } from "./contract.js";
import { TASKMASTER } from "./routing.js";

// Session keys (ARCH §1.2): agent:<agentId>:swarm:<task-id>:<role>.
// A fan-out lane member is its own session (ARCH §2): <role>:<n>, n from 1 to the lane count.

export const DEFAULT_AGENT_ID = "main";
const SWARM_MARKER = ":swarm:";
const MEMBER_RE = /^[a-z][a-z0-9_-]{0,31}(?::[1-9][0-9]*)?$/;

export function sessionKeyFor(taskId: string, role: string, agentId = DEFAULT_AGENT_ID): string {
  return `agent:${agentId}:swarm:${taskId}:${role}`;
}

export type SwarmSessionRef = { agentId: string; taskId: string; role: string };

/** Cheap prefix test so hooks can return before any I/O for non-swarm sessions. */
export function isSwarmSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(SWARM_MARKER);
}

/**
 * Split a session key. `role` keeps its member suffix (`audit:2`); callers that need the lane
 * role use `laneRoleOf`. A task id never contains a colon, so the key is exactly
 * agent:<agentId>:swarm:<taskId>:<role>.
 */
export function parseSwarmSessionKey(sessionKey: string | undefined): SwarmSessionRef | null {
  if (!isSwarmSessionKey(sessionKey)) {
    return null;
  }
  const raw = (sessionKey ?? "").trim().toLowerCase();
  const parts = raw.split(":");
  if (parts.length < 5 || parts[0] !== "agent" || parts[2] !== "swarm") {
    return null;
  }
  const [agentId, , , taskId] = parts;
  const role = parts.slice(4).join(":");
  if (!agentId || !taskId || !role || !TASK_ID_RE.test(taskId) || !MEMBER_RE.test(role)) {
    return null;
  }
  return { agentId, taskId, role };
}

export function isTaskmasterRole(role: string): boolean {
  return role === TASKMASTER;
}

/** The lane role a member key belongs to (`audit:2` → `audit`; `build` → `build`). */
export function laneRoleOf(member: string): string {
  const at = member.lastIndexOf(":");
  return at > 0 && /^\d+$/.test(member.slice(at + 1)) ? member.slice(0, at) : member;
}
