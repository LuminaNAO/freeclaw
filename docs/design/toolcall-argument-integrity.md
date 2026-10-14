# Tool-call argument integrity

Board item: newline-mangling-in-tool-writes.

## Symptom

Tool-call arguments that carry source code (exec `command`, write `content`, edit `newText`)
sometimes hold a literal backslash + `n` where a real newline belongs. The mangling starts right
after a block opener such as `for x in c:` or `if not b:`, then carries on through the following
lines. Python fails with "unexpected character after line continuation character". The bad bytes
are already in the `toolCall.arguments` stored in the session transcript.

## Finding

**The fault is not in this repo.** The root cause was the repair-first parse in the
`@openclaw/ai` library bundled in the provider proxy (cloudburst), version 2026.7.1-2, in
`dist/json-parse-*.mjs`:

- `parseStreamingJson(partialJson)` calls `parseJsonWithRepair` **first**, even when the buffer
  is complete, valid JSON.
- `parseJsonWithRepair(json)` runs `repairJson(json)` and parses the result whenever the repair
  changed anything (`if (repairedJson !== json) return JSON.parse(repairedJson)`).
- `repairJson`'s Windows-path branch:
  `if (JSON_CONTROL_ESCAPES.has(nextChar) && looksLikeWindowsPathPrefix(stringValuePrefix))`
  turns a valid `\n` (or `\t`, `\r`, `\b`, `\f`) escape into `\\n` (a literal backslash + n).
  `looksLikeWindowsPathPrefix` tests
  `/(?:^|[^A-Za-z0-9])[A-Za-z]:(?:[\\/][^"\\/:*?<>|\r\n]*)*$/`
  against the decoded text so far. Any line ending in `<non-alnum><single letter>:`, like
  `for x in c:` or `if not b:`, looks like the drive `c:` / `b:`. The escaped newline after it is
  doubled. The backslash it adds keeps the "path" going, so later newlines get doubled too until
  a character such as `"`, `:` or `|` breaks the pattern.

cloudburst's adapters call this on every tool call: `openai-completions-*.mjs` (toolcall end and
block finish) and `anthropic-*.mjs` (`input_json_delta` and `content_block_stop`). cloudburst's
own `server.mjs` then re-serialises the already-corrupted object with
`JSON.stringify(ev.toolCall.arguments)` into one `tool_calls` chunk. So freeclaw gets
**valid** JSON whose string values are already wrong, and stores it exactly as received.

This matches every model behind cloudburst (Sonnet, Opus, Grok, K3, MiMo, Qwen). Freeclaw only
sees the `openai-completions` API from cloudburst; the corruption happens on cloudburst's side.

### Evidence

1. **Freeclaw's stream path is byte-exact.** pi-ai 0.58.0 `streamOpenAICompletions` builds
   `partialArgs` by concatenation and parses with `JSON.parse` first. It only falls back to
   `partial-json` when the input is incomplete, and the final parse at block end is the same.
   Fed a fake SSE stream (stubbed `fetch`, no network) with deltas split one char at a time,
   inside escapes, between `\` and `n`, after `:` and after `\n`, plus 5-byte network framing,
   the arguments round-trip byte for byte. The test runs this stream through the wrappers that
   are active for openai-completions (`wrapStreamFnTrimToolCallNames`) and the transcript guard's
   `sanitizeToolCallInputs`. The kimi repair wrapper and the xAI entity decoder do not run for
   openai-completions providers.
2. **Redaction never touches tool arguments.** `redactSensitiveText` / `redactToolDetail`
   (`src/logging/redact.ts`) only run on logs, display details, errors, `sessions_history`
   output and the memory index. Nothing calls them on `toolCall.arguments` before the tool runs
   or before the transcript write. Source code with no secrets passes through them unchanged,
   raw or JSON-encoded.
3. **The upstream function reproduces the bug directly.** Calling cloudburst's bundled
   `parseStreamingJson` on `JSON.stringify({command: "for x in c:\n    t = ...\n"})`, which is
   valid JSON, returns `"for x in c:\\n    t = ...\\n"`.
   `"while True:\n    if not b:\n        break\n..."` keeps the first real newline (`True:` is
   not a drive) and mangles everything after `b:`. That is exactly the reported shape.
4. **Transcripts match.** Across the operator's local transcripts there are 147 tool-call
   string arguments with the `:` + literal `\n` + indentation shape. All are
   `openai-completions` via cloudburst providers. 144 of the 147 have a single letter right
   before the colon (the drive-letter trigger). The other 3 are code that legitimately writes
   `\n` escapes (string-replace and test fixtures).

### Credential-shaped masking

No masking layer in freeclaw touches tool arguments (point 2). The masked-looking values found
in transcript arguments (`"***"` in sed/python redaction one-liners the model wrote, and
`prefix…suffix` hash abbreviations in prose) are the model's own text. No freeclaw or
cloudburst code path produced them.

## Resolution

Fixed in the producer, by a dependency upgrade. Cloudburst moved its bundled `@openclaw/ai`
from 2026.7.1-2 to 2026.10.3 with no custom patch. In 2026.10.3, the final tool-call parse
parses valid JSON first and only repairs when parsing fails. The operator verified this end to
end: a live tool call containing `for x in c:` now comes through with 0 literal backslash-n.

The in-stream preview parse in 2026.10.3 still runs the repair first. That preview never leaves
cloudburst, because cloudburst only sends tool-call arguments at `toolcall_end`, as one
`tool_calls` chunk built from the final parse.

There is no freeclaw code change. Freeclaw must not add a "repair backslash-n" heuristic in
exec/write/edit, because that would corrupt legitimate escapes (`"a\nb"`, raw strings, Windows
paths). The tests in this branch guard freeclaw's own byte-exact path.

_Superseded:_ an earlier draft of this note listed two open options, patching the 2026.7.1-2
dependency or upgrading it. Those are no longer open; the upgrade above is the resolution.

## Tests (this repo)

`src/agents/toolcall-argument-integrity.test.ts`:

- Streamed openai-completions round trip through pi-ai's real `streamOpenAICompletions` with a
  stubbed fetch. It covers multiline Python (block openers, nested indentation, single-letter
  `c:` / `b:` openers, string literals with real `\n` escapes, raw strings, Windows paths,
  heredocs) through exec `command`, write `content` and edit `newText`, with five delta-split
  strategies. Arguments must match the original byte for byte at `toolcall_end`, in
  `result()`, and after `sanitizeToolCallInputs`.
- A signature test with a faithful reduction of the upstream `repairJson` drive-letter branch.
  It shows that branch rewrites valid `c:` + newline JSON, while freeclaw's path does not.
  It stays as a record of the old failure (fixed in cloudburst by the upgrade above).
- Redaction: source code with no secrets is never changed. A real `sk-…` / Bearer shape is still
  masked in log/display text. Tool arguments that contain a secret reach the tool, and the
  transcript, unchanged.
