# Reasoning display is never auto-enabled on chat channels — ARCH

Owned by the operator; engineers do not edit it. Each commit names the section it implements.

## 1. Problem (operator, 2026-10-18)

`src/auto-reply/reply/get-reply-directives.ts` (~line 421): when no reasoning level is set and thinking resolves to
`off`, the reply pipeline sets reasoning display from the model catalog (`resolveReasoningDefault`: `on` for any model
marked `reasoning: true`). Claude models are marked so; an agent with `thinkingDefault: "off"` then posts its internal
reasoning to Signal groups as visible "Reasoning:" messages, unasked.

## 2. Rule

1. On messaging channels (any inbound with a channel surface: Signal, WhatsApp, Telegram, Discord, Slack, Teams,
   iMessage, …), reasoning display defaults to **off** and is never turned on automatically. Only an explicit
   `/reasoning on` (session) or a configured default turns it on.
2. Add `agents.defaults.reasoningDefault?: "on" | "off" | "stream"` (and per-agent) as the explicit default; unset =
   off on channels, and the current catalog-derived behaviour stays only for non-channel surfaces (CLI, TUI, gateway
   `agent` method).
3. No change to thinking itself, to `/reasoning` behaviour, or to sessions that already set a reasoning level.

## 3. Tests

- Signal inbound, thinking off, reasoning-capable model, nothing set → reasoning off.
- Same with `/reasoning on` in the session → on.
- Same with `agents.defaults.reasoningDefault: "on"` → on.
- CLI/TUI path with a reasoning-capable model and nothing set → unchanged (catalog default).
- Schema + docs for `reasoningDefault`.
