import type { UpstreamSpec } from "./contract.js";
import { formatEnvelope, msgIdFor, type Envelope } from "./delivery.js";
import type { SwarmEngine } from "./engine.js";

// Upstream delivery (ARCH §1.7, §2, §7). Channels are optional and best-effort.

/** Sends text to a channel target; throws when the kind has no sender or the send fails. */
export type ChannelSender = (channel: { kind: string; to: string }, text: string) => Promise<void>;

type ChannelRuntimeLike = Record<string, Record<string, unknown> | undefined>;

/** Dispatch by channel kind to the runtime's per-channel `sendMessage<Kind>` function. */
export function createRuntimeChannelSender(channelRuntime: unknown): ChannelSender {
  return async (channel, text) => {
    const kind = channel.kind.trim().toLowerCase();
    const group = (channelRuntime as ChannelRuntimeLike | undefined)?.[kind];
    const fnName = `sendMessage${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    const fn = group?.[fnName];
    if (typeof fn !== "function") {
      throw new Error(`no sender for channel kind "${kind}"`);
    }
    await (fn as (to: string, text: string) => Promise<unknown>)(channel.to, text);
  };
}

export async function deliverUpstream(params: {
  engine: SwarmEngine;
  taskId: string;
  upstream: UpstreamSpec;
  envelope: Envelope;
  channelSender?: ChannelSender;
}): Promise<void> {
  const { engine, taskId, upstream, envelope } = params;
  if (!upstream.events.includes(envelope.event)) {
    engine.record(taskId, {
      kind: "upstream",
      event: envelope.event,
      to: null,
      sha: envelope.sha,
      data: { skipped: "event not in upstream.events" },
    });
    return;
  }
  const rec = engine.record(taskId, {
    kind: "upstream",
    event: envelope.event,
    from: envelope.from,
    to: "upstream",
    sha: envelope.sha,
    body: envelope.body,
    data: {
      sessionKey: upstream.sessionKey ?? null,
      channel: upstream.channel?.kind ?? null,
    },
  });
  const msgId = msgIdFor(taskId, [rec.seq], "upstream");
  const text = formatEnvelope(envelope, msgId);

  if (upstream.sessionKey) {
    await engine.mailbox.deliver({
      stateDir: engine.stateDir,
      taskId,
      targetSessionKey: upstream.sessionKey,
      to: "upstream",
      seqs: [rec.seq],
      idempotencyKey: msgId,
      message: text,
    });
  }

  if (upstream.channel) {
    try {
      if (!params.channelSender) {
        throw new Error("no channel sender available");
      }
      await params.channelSender(upstream.channel, text);
    } catch (err) {
      // A channel never fails or blocks a task (ARCH §1.7).
      engine.record(taskId, {
        kind: "system",
        event: "UPSTREAM_CHANNEL_FAILED",
        sha: envelope.sha,
        data: {
          kind: upstream.channel.kind,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
