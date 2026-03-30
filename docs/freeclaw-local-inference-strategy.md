# Freeclaw: Local Inference Reliability — Development & Testing Strategy

## Mission

Make OpenClaw work reliably with local inference (llama.cpp). Upstream openclaw
is designed around fast cloud inference; its timeout values, retry logic, and
error handling all assume responses in seconds. Local models — especially large,
dense ones on consumer hardware — can take minutes per response. The goal is to
patch this without forking the whole codebase: surgical, traceable changes only.

---

## Current Environment

| Component        | Detail |
|-----------------|--------|
| Model            | Qwen 3.5 27B BF16 (dense, slow — ideal for finding bottlenecks) |
| Backend          | llama.cpp (ROCm build) |
| Server port      | 40801, api-key `ollama-local` |
| Context window   | 122,368 tokens (4 slots) |
| GPU VRAM used    | ~73% at rest with model loaded |
| Gateway port     | random 18000–19000 (reused across restarts) |
| Gateway bind     | lan (0.0.0.0) |
| Node             | v24 (nvm) |

---

## Known Failure Mode

At high context (long conversations, large tool outputs, many tool calls),
openclaw stops responding. Exact mechanism unknown but hypotheses:

1. **Client-side timeout fires** — openclaw's default agent timeout is **600
   seconds (10 minutes)**. The timer fires, `abortRun(isTimeout=true)` is
   called. The current freeclaw fix skips the `session.abort()` for local
   providers, but the run still transitions to a failed/timed-out state from
   openclaw's perspective even while llama.cpp is still generating.

2. **Context window pressure** — at high token counts, llama.cpp slot processing
   slows dramatically (attention scales quadratically). A 60s response at 2k
   tokens can become 600s+ at 60k tokens. The 10-minute timeout was never
   designed for this.

3. **Compaction race** — when context fills, openclaw triggers compaction
   (summarization). The compaction itself is a new inference call. If the
   original call is still running when compaction fires, there may be a race or
   deadlock. Compaction timeout was bumped to 20min as a workaround.

4. **Silent hang** — llama.cpp may stop producing tokens without erroring (OOM,
   KV cache eviction, slot contention from 4-slot config). From openclaw's side
   this looks identical to slow generation.

---

## What's Already Fixed

| Commit | Fix |
|--------|-----|
| `5997c75` | Timeout logger + exclude local providers from rate-limit detection |
| `0f6c4e1` | Skip `session.abort()` for local providers on timeout |
| `2d14fc5` | Compaction timeout bumped 5min → 20min |

---

## Timeout Architecture (as understood)

```
openclaw agent --timeout <seconds>    ← CLI override (default 600s)
    └── resolveAgentTimeoutMs()       ← src/agents/timeout.ts
        └── DEFAULT_AGENT_TIMEOUT_SECONDS = 600
        └── can be overridden via config: agents.defaults.timeoutSeconds
            └── passed as params.timeoutMs to runEmbeddedAttempt()
                └── fires abortRun(isTimeout=true)
                    └── [FIXED] skips abort for local providers
                    └── [PROBLEM] run still appears failed to caller
```

**Key finding:** Setting `agents.defaults.timeoutSeconds = 0` in openclaw config
maps to `MAX_SAFE_TIMEOUT_MS` (≈2,147,000 seconds / ~24 days) — effectively
no timeout. This is a safe config-level fix for local providers.

---

## Monitoring Stack

### GPU (AMD ROCm)
```bash
# One-shot GPU use + VRAM
rocm-smi --showuse --showmemuse

# Continuous (poll every 2s)
watch -n2 'rocm-smi --showuse --showmemuse --showpower'

# Full detail (interactive, good for humans)
amdgpu_top
```

### llama.cpp server log
```bash
tail -f ~/llama.log | grep -E "slot|task|cancel|error|timeout|stop|busy"
```

### Gateway log
```bash
journalctl --user -u openclaw-gateway.service -f
```

### Combined monitor (run before each test)
```bash
tail -f ~/llama.log | grep --line-buffered -E "slot|task|cancel|error|timeout|stop|busy" &
watch -n2 'rocm-smi --showuse --showmemuse' &
```

---

## Test Harness

Drive tests via CLI (automatable, no TUI needed):

```bash
# Source env
source ~/.nvm/nvm.sh && export PNPM_HOME="$HOME/.local/share/pnpm" && export PATH="$PNPM_HOME:$PATH"

# Basic test — short prompt
openclaw agent --message "Hello, reply in one sentence." --timeout 120

# Medium — requires some reasoning
openclaw agent --message "Explain the tradeoffs between attention mechanisms in transformers. Be thorough." --timeout 300

# High context stress — force long output + tool use
openclaw agent --message "Write a 2000 word essay on the history of computing, then summarize it." --timeout 0

# Repeat turns on same session (builds context)
SESSION_ID=$(openclaw agent --message "Start counting from 1." --json | jq -r '.sessionId')
openclaw agent --session-id "$SESSION_ID" --message "Continue for another 50 numbers and explain each one's mathematical properties." --timeout 0
```

`--timeout 0` = no timeout (maps to MAX_SAFE_TIMEOUT_MS). Use this to isolate
whether timeout is the issue vs a genuine hang.

---

## Fix/Test Loop

1. **Baseline**: Run a stress prompt, observe failure mode in logs
2. **Diagnose**: Cross-reference llama.log (is llama.cpp still running?) with
   gateway log (what does openclaw report?)
3. **Fix**: Targeted patch in `src/agents/pi-embedded-runner/`
4. **Rebuild**: `bash ~/code/openclaw-helpers/openclaw-switch.sh rebuild free`
   (same-branch rebuild — skips node_modules reinstall, much faster)
   Then restart gateway: `systemctl --user restart openclaw-gateway`
5. **Retest**: Same prompt, check if failure mode is gone
6. **Commit**: Only commit when fix is verified working

---

## Immediate Investigation Targets

### Priority 1: Config-level timeout disable for local providers
`src/agents/timeout.ts` — add logic so when the configured provider is local
(llama.cpp/ollama/etc), `agents.defaults.timeoutSeconds` defaults to 0 (no
timeout) rather than 600. This avoids the timeout firing at all for local users.

### Priority 2: What happens after timeout fires for local provider?
Currently `abortRun(isTimeout=true)` skips the abort but the run is still
marked timed out. Does openclaw return an error to the user? Does it keep
waiting? Does it retry? Trace through `attempt.ts` post-`abortRun`.

### Priority 3: Silent hang detection
If llama.cpp stops producing tokens (OOM, KV eviction), openclaw sees no
stream events. We need a "last token received" heartbeat: if no tokens for
N seconds, log a warning and optionally surface it to the user.

### Priority 4: KV cache / slot contention
llama.cpp is configured with 4 slots (`-n_slots 4`). For a single-user local
setup this wastes VRAM on idle slots and increases KV cache pressure. Consider
reducing to 1 slot and increasing context per slot.

---

## Notes

- Dense 27B BF16 is intentional — it's slow enough to expose timing issues that
  a quantized model would race past. Once reliable with 27B BF16, smaller/faster
  models will be fine.
- Do not increase llama.cpp `--timeout 3600` — the server timeout is fine. The
  problem is openclaw's client-side logic, not the server.
- Gateway restarts are cheap. Rebuild is ~30s (same-branch, no node_modules clean).
