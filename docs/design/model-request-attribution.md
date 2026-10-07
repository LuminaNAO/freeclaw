# Model request attribution headers — ARCH

Source of truth for attribution headers on model requests. Owned by the operator; engineers do not edit it.
Architecture-driven: no separate spec; each commit names the section it implements. A real conflict with the
code is raised as `BLOCKED`, not resolved in code.

## 1. Problem

Usage dashboards on the model-provider side (an LLM gateway such as cloudburst, then tokentail) need to know
which agent on which gateway sent a request. Today the gateway sends `X-OpenClaw-Agent-Id`,
`X-OpenClaw-Session-Id` and related headers only to llama.cpp and loopback-addressed providers
(`shouldInjectOpenClawLlamaHeaders`). Two gaps:

- a provider on a non-loopback address (another host on the private network, a remote gateway) gets no
  attribution at all;
- every gateway's default agent is called `main`, so even with headers, several gateways sharing one provider
  are indistinguishable.

## 2. Rules

1. **Every model request from an agent run carries the attribution headers**, whatever the provider.
2. **Minimal.** Reuse `buildOpenClawLlamaHeaders` / `createOpenClawLlamaHeadersWrapper`. No new mechanism.
3. **Nothing private.** The headers carry identifiers already used internally (agent id, session key, session
   id, run id, trigger, agent kind) and the operator-chosen instance name. Never message content, sender
   identity, phone numbers, channel ids or credentials.
4. **No behaviour change** for llama.cpp / loopback providers (their headers stay exactly as today, including
   `X-OpenClaw-Cache-Policy`).

## 3. Headers

| Header                    | Value                                           | Sent to                             |
| ------------------------- | ----------------------------------------------- | ----------------------------------- |
| `X-OpenClaw-Agent-Id`     | the agent id (e.g. `main`)                      | every provider                      |
| `X-OpenClaw-Agent-Kind`   | `main` or `subagent`                            | every provider                      |
| `X-OpenClaw-Session-Id`   | the slot/session id exactly as today            | every provider                      |
| `X-OpenClaw-Session-Key`  | the session key                                 | every provider                      |
| `X-OpenClaw-Run-Id`       | the run id                                      | every provider                      |
| `X-OpenClaw-Trigger`      | the trigger                                     | every provider                      |
| `X-OpenClaw-Instance`     | `gateway.instanceName` (§4); omitted when unset | every provider                      |
| `X-OpenClaw-Cache-Policy` | as today                                        | llama.cpp / loopback providers only |

Values are cleaned exactly as `cleanHeaderValue` does today (control characters removed, 512-char cap).

## 4. Config

`gateway.instanceName?: string`: an operator label for this gateway (for example `alpha`, `beta`, `dev`), so
one dashboard can tell apart gateways whose agents are all called `main`. Optional; unset = the header is
omitted. Added to the config schema and types with a one-line description. No other config.

## 5. Opt-out

None. These are internal identifiers for the operator's own providers. A provider that ignores unknown
headers is unaffected.

## 6. Acceptance

1. Unit: `buildOpenClawLlamaHeaders` with and without `instanceName`; cache policy present only for llama.cpp /
   loopback; header values cleaned.
2. Unit: a run against a non-loopback, non-llama provider gets the agent headers; a llama.cpp provider still gets
   exactly today's set (plus Instance when configured).
3. Live: a throwaway gateway with `gateway.instanceName: "attrib-test"` and two agents (`main`, `beta`),
   with one `openai-completions` provider whose base URL is a local HTTP echo server bound to the host's
   non-loopback interface address. Run one turn per agent; the echo server log shows
   `X-OpenClaw-Agent-Id: main` and `beta`, `X-OpenClaw-Instance: attrib-test`, and no
   `X-OpenClaw-Cache-Policy`. A second provider on a loopback address still gets the cache-policy header.
4. Full test suite green; no new dependency.
