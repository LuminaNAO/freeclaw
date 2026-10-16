# Narration follows delivery mode — ARCH

Owned by the operator; engineers do not edit it. Each commit names the section it implements.

## 1. Problem (operator, 2026-10-16)

With block streaming off (`agents.defaults.blockStreamingDefault: "off"`, or a channel `blockStreaming: false`),
every assistant text written during a turn is held and delivered at the end, each as its own message. The system
prompt's "Tool Call Style" section tells the model to "narrate only when it helps: multi-step work ...", which the
model reads as permission to write a progress line before most tool calls. Result: long silence, then a burst of
stale progress messages. No setting controls narration; it is a prompt instruction.

## 2. Rule

1. `buildAgentSystemPrompt` takes the turn's resolved block-streaming state (on/off) as an input.
2. **Streaming on:** "Tool Call Style" is unchanged.
3. **Streaming off:** the two narration lines ("Default: do not narrate routine..." and "Narrate only when it
   helps...") and "Keep narration brief..." / "Use plain human language for narration..." are replaced by:
   - "Replies here are delivered only when your turn ends, and every text you write during the turn arrives as a
     separate message at that moment. Do not write progress or narration between tool calls. Work silently, then
     write one final reply."
   - "If a task will take long, say so in one short line before the first tool call, then stay silent until the
     final reply."
     All other lines in the section stay.
4. The streaming state passed is the same one the reply pipeline uses (`resolvedBlockStreaming` after
   `disableBlockStreaming` from the channel), so a channel override is respected. Callers without a channel context
   (CLI runner, `/system-prompt` command) pass the agent default.
5. No code change to delivery: what the model writes is still delivered as today.

## 3. Tests

- Prompt text with streaming on contains the original narration lines and not the new ones; with streaming off,
  the reverse.
- The channel override (`channels.signal.blockStreaming: false` with agent default on) yields the off text.
- `/system-prompt` output matches the agent default.
- Snapshot of the rest of the section unchanged in both modes.
