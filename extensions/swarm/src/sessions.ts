import { HOLON_KEY_SEPARATOR, TASK_ID_RE } from "./contract.js";
import { TASKMASTER } from "./routing.js";

// Session keys (ARCH §1.2, §2): agent:<agentId>:swarm:<root>[:<path>]:<role>[:<n>].
// A fan-out lane member is its own session: <role>:<n>, n from 1 to the lane count. A child
// holon's key `root/c1/c2` (ARCH §5) becomes `root:c1:c2` in the session key.

export const DEFAULT_AGENT_ID = "main";
const SWARM_MARKER = ":swarm:";
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function sessionKeyFor(taskId: string, role: string, agentId = DEFAULT_AGENT_ID): string {
  return `agent:${agentId}:swarm:${taskId.split(HOLON_KEY_SEPARATOR).join(":")}:${role}`;
}

export type SwarmSessionRef = { agentId: string; taskId: string; role: string };

/** Cheap prefix test so hooks can return before any I/O for non-swarm sessions. */
export function isSwarmSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(SWARM_MARKER);
}

/**
 * Split a session key. `role` keeps its member suffix (`audit:2`); callers that need the lane
 * role use `laneRoleOf`. `taskId` is the holon key (`root` or `root/c1/c2`). Unambiguous:
 * the role is always last (with an optional numeric member suffix), and a role starts with a
 * letter while every holon segment is a holon id.
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
  const agentId = parts[1];
  const rest = parts.slice(3);
  const member = /^[1-9][0-9]*$/.test(rest.at(-1) ?? "") ? 2 : 1;
  const roleParts = rest.slice(-member);
  const holon = rest.slice(0, -member);
  const role = roleParts.join(":");
  if (
    !agentId ||
    holon.length === 0 ||
    !ROLE_RE.test(roleParts[0] ?? "") ||
    holon.some((s) => !TASK_ID_RE.test(s))
  ) {
    return null;
  }
  return { agentId, taskId: holon.join(HOLON_KEY_SEPARATOR), role };
}

export function isTaskmasterRole(role: string): boolean {
  return role === TASKMASTER;
}

/** The lane role a member key belongs to (`audit:2` → `audit`; `build` → `build`). */
export function laneRoleOf(member: string): string {
  const at = member.lastIndexOf(":");
  return at > 0 && /^\d+$/.test(member.slice(at + 1)) ? member.slice(0, at) : member;
}
