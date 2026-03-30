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

## Live Test Results

### Run 1 — 2026-03-31 (Qwen 3.5 27B BF16, ROCm)

**Test:** rustyclaw build tasks driven via openclaw CLI, 10 incremental tasks on same session.

| Task | Result | Duration | Context (tokens) | Notes |
|------|--------|----------|-----------------|-------|
| 1 — bootstrap | ✅ | 127s | ~15.9k | First run after fixes |
| 2 — HTTP client | ✅ | 207s | ~17.0k | Context growing normally |
| 3 — SSE parser | ✅ | 528s | ~20k → 4.5k | Compaction fired mid-task; would have hit 600s timeout |
| 4 — conversation core | running | - | growing | - |

**Key observations:**
- With `--timeout 0`, embedded mode works — no premature aborts
- GPU spikes to ~89% during generation, returns to ~4% idle — healthy
- VRAM holds steady at 74% (pre-allocated by llama.cpp — no growth)
- Context checkpointing working well (KV cache reuse ~99%)
- WS gateway handshake still timing out — fallback to embedded works, but investigate
- Session ID not being returned in JSON output — driver uses stateless calls (each turn re-sends full context via embedded runner)

**Issues found:**
- `openclaw agent --json` not returning `sessionId` in output → driver can't chain sessions via session ID. Openclaw embedded runner maintains session internally per agent. No fix needed for functionality but means full conversation history is re-sent each turn (explains the context growth).

**WS Gateway issue:** `[ws] handshake timeout` — gateway is running but WS auth handshake times out. HTTP health endpoint works fine. Needs investigation — may be a timing issue in the WS auth negotiation on slow local inference setups.

## llama.cpp Observations (from llama.log)

### Performance
- **Generation speed**: ~3.93–3.99 tok/s (eval) — very consistent regardless of context size. Good ROCm baseline.
- **Prefill speed**: 28–72 tok/s depending on batch size. Larger batches prefill faster (expected). KV cache checkpoint reuse interferes with batch sizing sometimes.
- **Task 3 took 528s** — would have been killed by the old 600s default timeout with only 72s to spare. Confirms `--timeout 0` is essential.

### Flags that do nothing for Qwen3.5 BF16
- **`--swa-full`**: Log says `swa_full is not supported by this model, it will be disabled`. This flag in the launcher is dead weight — remove it.
- **Speculative decoding**: `speculative decoding not supported by this context` — not harmful but not doing anything either.

### KV Cache / Slots
- **4 slots (`-n_slots 4` implied by default)**: Only slot 3 was used throughout all tasks. 3 idle slots are consuming VRAM for KV cache that will never be used in a single-user local setup. **Recommendation: launch with `--parallel 1`** (or `-np 1`) to reduce to 1 slot and free that VRAM for larger context.
- **Context checkpointing**: Working well — llama.cpp creates checkpoints every ~500 tokens and reuses them (LCP similarity >0.94). Very efficient for multi-turn where context grows incrementally.

### Compaction behavior (task 3088)
- Context grew to ~20k tokens, then openclaw compaction fired.
- llama.cpp saw a new prompt with `n_past=4572` (post-compaction summary) vs `19929` tokens total — a ~75% context reduction.
- All old KV checkpoints were erased cleanly. No errors. This is the system working as designed.
- **Implication**: openclaw compaction is working but is expensive (fires a full summarization call). At ~4 tok/s, a 500-token summary takes ~125s — this is invisible to the user but adds latency between turns when compaction fires.

### Launch flags to investigate
| Flag | Current | Suggestion | Reason |
|------|---------|-----------|--------|
| `--swa-full` | present | remove | does nothing for this model |
| `-n_slots` / `--parallel` | 4 (default) | 1 | single-user, saves VRAM/KV cache |
| `--no-mmap` | present | test without | BF16 on ROCm may load fine with mmap; could speed up startup |
| `-c 122144` | present | keep | large context is the goal |
| `-fa on` | present | keep | Flash attention helps with long context on ROCm |
| `--temp 0.3` | present | consider 0.6 | low temp can cause repetition loops on coding tasks |

## Notes

- Dense 27B BF16 is intentional — it's slow enough to expose timing issues that
  a quantized model would race past. Once reliable with 27B BF16, smaller/faster
  models will be fine.
- Do not increase llama.cpp `--timeout 3600` — the server timeout is fine. The
  problem is openclaw's client-side logic, not the server.
- Gateway restarts are cheap. Rebuild is ~30s (same-branch, no node_modules clean).
