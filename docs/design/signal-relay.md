# Signal Relay — Architecture

Status: **design only, not integrated yet** (2026-09-06)
Owner: the operator + Lumina · First target: **Arthur** (a remote agent, `<relay-agent-ip>` · Second: **Herman** (dad's agent, machine TBD)

## Problem

OpenClaw's Signal channel is bound 1:1 to the machine running signal-cli. Lumina
(the host) is the only NAO with a Signal account. Arthur (a remote agent, `<relay-agent-ip>` and
Herman (dad) run agents **without Signal accounts**, and we do not want to give
them Signal accounts (account ownership stays singular: Lumina's).

The operator wants ordinary Signal groups — "Arthur", "Herman" — in which Lumina is a
member, but where all traffic is transparently relayed to the remote agent and
its replies come back into the same group, attributed to the agent.

## Design decision: stub-agent + tool (not a raw hook)

**Chosen: local stub agent per remote agent, routed by the existing
per-group→agentId binding.** Rejected alternatives below.

Why not hooks alone: the `message_received` plugin hook
(`src/plugins/types.ts`, `PluginHookName`) is fire-and-forget
(`=> Promise<void>`) — it **cannot cancel** the local agent's turn. Intercepting
inbound group traffic at hook level would still run Lumina's agent on every
message. The binding system (`agents.list` + per-channel bindings carrying
`agentId`, see `src/config/agent-dirs.ts`) routes a group to a specific agent
_before_ any agent runs — no hook needed for inbound.

### Shape

```
Signal group "Arthur" (members: the operator, Lumina-account)
        │  inbound (signal-cli, host gateway)
        ▼
Gateway binding: group:<id> → agentId: "arthur-relay"   (local stub agent)
        │
        ▼
arthur-relay (stub agent, thin system prompt, single tool)
   tool: signal_relay_send({text, group})
        │  HTTPS, bearer token, loopback/LAN only
        ▼
Arthur's gateway (`<relay-agent-ip>` — OpenAI-compat endpoint
   POST /v1/chat/completions
   body.user  = group id      → stable session per group
   body.messages = [ …, { role:"user",
                          content: "[group:Arthur] the operator: …" } ]
        │  final assistant text
        ▼
arthur-relay replies verbatim → gateway → signal-cli → group "Arthur"
```

Outbound needs **no hook**: the stub agent just answers, and the normal channel
send path delivers it to the group. Replies appear from Lumina's Signal account,
prefixed by the relay (e.g. `Arthur:`) so group members can tell whose turn it is.

### Stub agent contract

- One stub per remote agent: `arthur-relay`, `herman-relay` in `agents.list`.
- System prompt: _You are a relay. Never answer yourself. On every inbound
  message call `signal_relay_send` with the full sender-attributed text and
  reply with its result verbatim. If the relay errors, say so briefly._
- Single custom tool: `signal_relay_send` (module-provided, registered by the
  plugin; only exposed to the stub agent).
- Stubs keep no interesting state — conversation state lives entirely on the
  remote agent's gateway, keyed by the `user` field (= Signal group id).

### Agent-to-agent transport

Reuse the gateway's existing OpenAI-compatible endpoint (`/v1/chat/completions`,
`src/gateway/openai-http.ts`). Every OpenClaw gateway already serves it; the
`user` field maps to session key, giving per-group conversation persistence on
Arthur's box with zero new protocol.

- Transport: LAN/WireGuard only (mesh), bearer token per remote agent.
- Request timeout: long (agent turns can run minutes); non-stream for v1.
- Sender identity is injected as a text prefix, not metadata — remote agents
  have no channel metadata plumbing yet. Format:
  `[group:Arthur] <sender display> (<Signal uuid>): <text>`

## v2 — push mode (agent-initiated sends)

Request/response covers one reply per turn. For agents that message mid-task
(progress updates, multi-step work), the remote agent must be able to **initiate**
sends into the group:

- Module exposes a webhook route on the host gateway (`src/plugins/webhook-*`
  infrastructure already exists) that the remote agent's tools can POST to:
  `POST /signal-relay/send {token, group, text}`.
- Host gateway sends it via its signal-cli as the attributed reply.
- Remote agents get a thin `relay_send` tool pointed at this endpoint.

This mirrors how I already use the `message` tool, generalized across machines.

## v3 — generalization

- Herman: second `agents` entry (machine + IP once known), nothing else changes.
- Health: relay liveness (can the remote endpoint answer a `GET /v1/models`)
  folded into the daily infrastructure check cron.
- Multi-account: if a remote agent ever _does_ get its own Signal account, the
  relay degrades gracefully to a plain binding — the stub is then just a
  normal agent.

## Security model

| Rule                                                  | Mechanism                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Only registered agents may use the relay              | Per-agent bearer token, checked on every call; unknown token → 401, logged                                                          |
| No LAN exposure of the relay endpoint                 | Bind 127.0.0.1 on the remote gateways; relay call path stays on the mesh                                                            |
| Lumina's Signal account stays the only Signal account | Relay sends always originate from the host gateway's signal-cli                                                                     |
| No impersonation of Lumina's voice                    | Outbound replies carry the agent prefix; stubs never compose content themselves                                                     |
| Sender attribution is explicit                        | Inbound text carries sender display + Signal uuid prefix; remote agents treat it as untrusted input (standard rule for all inbound) |
| No cloud egress                                       | All hops stay on the private WireGuard mesh                                                                                         |
| Group allowlist                                       | Only the mapped group ids may be relayed; a stub calling with an unmapped group id is rejected                                      |

## Config surface (v1 sketch)

```json5
{
  agents: {
    list: [
      // … existing …
      { id: "arthur-relay", name: "Arthur Relay" /* stub prompt */ },
    ],
    bindings: [
      {
        match: { channel: "signal", peer: { kind: "group", id: "<signal group id of 'Arthur'>" } },
        agentId: "arthur-relay",
      },
    ],
  },
  plugins: {
    entries: {
      "signal-relay": {
        enabled: true,
        config: {
          endpoints: {
            arthur: {
              url: "http://<relay-agent-ip>:<gateway-port>/v1",
              token: "<static bearer>",
              prefix: "Arthur",
              groups: { Arthur: "<signal group id>" },
              timeoutSeconds: 600,
            },
            // herman: { … } — phase 3
          },
        },
      },
    },
  },
}
```

## Module layout (when we build)

```
extensions/signal-relay/
  index.ts                 # plugin registration (tool + optional webhook)
  openclaw.plugin.json
  src/
    dispatch.ts            # remote agent call (OpenAI-compat client)
    relay-send-tool.ts     # signal_relay_send tool definition
    webhook.ts             # v2 push endpoint
    config.ts              # schema + validation
docs/design/signal-relay.md  # this document
```

## Phases

- **P0** — this doc. ✅
- **P1 (Arthur)** — stub agent + binding + `signal_relay_send` + request/response dispatch. Verify: the operator pings in the Arthur group → Arthur answers there; Arthur's own session stays coherent across turns.
- **P2** — push mode webhook.
- **P3** — Herman entry + cron health check.

## Open questions

1. **Arthur's gateway port** — what port does the relay agent's OpenClaw gateway
   serve the OpenAI-compat endpoint on? (Need to confirm; also whether
   `/v1/chat/completions` is enabled there.)
2. **Group ids** — do the "Arthur"/"Herman" groups already exist on Signal, and
   is Lumina's account already a member? The binding key is the gateway's
   normalized `group:<…>` chat id.
3. **Identity prefix** — `Arthur:` vs `Arthur (remote agent):` vs bare text.
4. **Sender names** — remote agents get Signal display names (unstable) +
   uuid; should the relay resolve uuid→known-name via the trust graph before
   dispatching? (Nice to have; keep raw uuid in v1.)
