// Hands a mail batch to an attached session (docs/design/mail-push.md §4):
// - wakeMode "now": one agent turn in the session (created if missing), awaited, so the batch
//   counts as accepted only when the turn finished.
// - wakeMode "next-heartbeat": one queued system event for the session.
// The turn runs without owner trust (mail is external input), and nothing is delivered to a chat
// unless the attachment sets deliver: true.
import { randomUUID } from "node:crypto";
import type { CliDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { RuntimeEnv } from "../runtime.js";
import type { MailSessionEvent, MailSessionSink } from "./connector.js";
import type { MailLogger } from "./types.js";

export const MAIL_SOURCE_CHANNEL = "mail";

export type MailAgentRunner = typeof agentCommandFromIngress;

/** Quiet runtime for mail turns: replies go nowhere unless delivered; errors become warnings. */
function createMailRuntime(log: MailLogger, connectorId: string): RuntimeEnv {
  return {
    log: () => {},
    error: (...args: unknown[]) => {
      log.warn(`mail connector ${connectorId}: ${args.map(String).join(" ").slice(0, 200)}`);
    },
    exit: (code: number) => {
      throw new Error(`mail agent turn exited with code ${code}`);
    },
  };
}

export function createMailSessionSink(params: {
  log: MailLogger;
  deps?: CliDeps;
  runAgent?: MailAgentRunner;
  enqueue?: typeof enqueueSystemEvent;
  wake?: typeof requestHeartbeatNow;
}): MailSessionSink {
  const runAgent = params.runAgent ?? agentCommandFromIngress;
  const enqueue = params.enqueue ?? enqueueSystemEvent;
  const wake = params.wake ?? requestHeartbeatNow;

  return async (event: MailSessionEvent) => {
    const { attach } = event;
    const contextKey = `mail:${event.connectorId}:${event.messageIds[0] ?? ""}`;
    if ((attach.wakeMode ?? "now") === "next-heartbeat") {
      enqueue(event.text, { sessionKey: attach.sessionKey, contextKey });
      wake({
        reason: `mail:${event.connectorId}`,
        sessionKey: attach.sessionKey,
        agentId: attach.agentId,
        coalesceMs: 60_000,
      });
      return;
    }
    const deliver = attach.deliver === true;
    await runAgent(
      {
        message: event.text,
        agentId: attach.agentId,
        sessionKey: attach.sessionKey,
        // Mail is untrusted external input: no owner-only tools for these turns.
        senderIsOwner: false,
        deliver,
        ...(deliver && attach.channel ? { channel: attach.channel } : {}),
        ...(deliver && attach.to ? { to: attach.to } : {}),
        ...(attach.model ? { modelOnce: attach.model } : {}),
        ...(attach.thinking ? { thinkingOnce: attach.thinking } : {}),
        inputProvenance: { kind: "external_user", sourceChannel: MAIL_SOURCE_CHANNEL },
        abortSignal: event.signal,
        runId: `mail-${event.connectorId}-${randomUUID()}`,
      },
      createMailRuntime(params.log, event.connectorId),
      params.deps,
    );
  };
}
