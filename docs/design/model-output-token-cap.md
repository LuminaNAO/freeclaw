# Model output token cap — ARCH

Source of truth for the per-request output token cap. Owned by the operator; engineers do not edit it.
Architecture-driven: no separate spec; each commit names the section it implements. A real conflict with the
code is raised as `BLOCKED`, not resolved in code.

## 1. Problem

The model client library (`@mariozechner/pi-ai`, `buildBaseOptions`) sends
`maxTokens = options.maxTokens || Math.min(model.maxTokens, 32000)`. The gateway only passes `maxTokens` when
an operator sets `params.maxTokens`. So every model is silently capped at 32,000 output tokens per reply, whatever
its configured `maxTokens` says. A long reply (e.g. a large file written in one tool call) is cut off with
`stopReason: length` mid-tool-call and the run ends without its result.

## 2. Rule

1. The configured model `maxTokens` is the default output cap for every request. No hidden 32,000 default.
2. An explicit `params.maxTokens` (model entry or agent) still wins, clamped to the model's `maxTokens`.
3. A model with no `maxTokens` configured keeps today's library behaviour.
4. Minimal: one place in the gateway's stream setup supplies `maxTokens` when the caller did not. No library
   fork, no dependency change, no new config.

## 3. Acceptance

1. Unit: model `maxTokens: 128000`, no params -> request carries 128000. `params.maxTokens: 50000` -> 50000.
   `params.maxTokens: 200000` with model 128000 -> 128000. Model without `maxTokens` -> unchanged behaviour.
2. Unit: thinking-enabled requests still fit the thinking budget inside the cap (existing pi-ai
   `adjustMaxTokensForThinking` path keeps working).
3. Live, throwaway gateway with one `openai-completions` provider pointed at a local echo server that records the
   request body: a turn on a model configured `maxTokens: 100000` sends `max_tokens` (or `max_completion_tokens`)
   = 100000.
4. Full test suite green; no new dependency.
