# FreeClaw Exploration: Local Inference Timeout Issues

## Overview

This document explores the two main timeout issues that affect local inference (llama.cpp, Ollama, vLLM, etc.) in OpenClaw:

1. **10-minute hard timeout** that kills long-running inference tasks (especially at 80k+ tokens)
2. **Rate-limit detection** that incorrectly flags local inference as rate-limited

## Findings

### 1. 10-Minute Inference Timeout

**Location:** `src/agents/timeout.ts`

```typescript
const DEFAULT_AGENT_TIMEOUT_SECONDS = 600; // 10 minutes
```

**Flow:**
1. User message → `agentCommand()` in `src/commands/agent.ts`
2. Calls `resolveAgentTimeoutMs()` which defaults to 600 seconds (10 min)
3. Timeout passed to `runEmbeddedPiAgent()` as `params.timeoutMs`
4. Passed to `runEmbeddedAttempt()` which sets up `AbortController`
5. `runAbortController.timeout(600000ms)` kills the task at 10 minutes

**Evidence:**
- Line 1119 in `src/agents/pi-embedded-runner/run/attempt.ts`:
  ```typescript
  runAbortController.timeout(Math.max(1, params.timeoutMs));
  ```
- Line 1038: `runAbortController.abort(makeTimeoutAbortReason())`
- This is the "srv stop: cancel task" message you see in llama.cpp

**Impact:**
- Deep thinking at 80k+ tokens takes >10 min
- Task is killed mid-inference
- llama.cpp shows `srv stop: cancel task, id_task = 1234`
- Results in infinite retry loop or hanging

### 2. Rate-Limit Detection for Local Inference

**Location:** `src/agents/pi-embedded-helpers/errors.ts`

**Patterns that trigger rate-limit detection:**
```typescript
rateLimit: [
  /rate[_ ]limit|too many requests|429/,
  "model_cooldown",
  "cooling down",
  "exceeded your current quota",
  "resource has been exhausted",
  "quota exceeded",
  "resource_exhausted",
  "usage limit",
  "tpm",
  "tokens per minute",
],
```

**Problem:**
- Local inference (llama.cpp, Ollama, vLLM) should NEVER be rate-limited
- These errors come from the LLM API responses, not from OpenClaw
- When a local model returns any of these patterns (or similar), it triggers profile rotation
- This is incorrect for local providers since they don't have rate limits

**Detection Function:**
```typescript
export function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") {
    return false;
  }
  return isRateLimitErrorMessage(msg.errorMessage ?? "");
}
```

**Where it's used:**
- In `src/agents/pi-embedded-runner/run.ts` at line 956:
  ```typescript
  const rateLimitFailure = isRateLimitAssistantError(lastAssistant);
  ```
- Used to trigger profile rotation on "rate limit" errors
- **BUG:** Should exclude local providers (ollama, vllm, llama.cpp, etc.)

### 3. Other Relevant Timeouts

**Cron Job Timeout:** `src/cron/service/timeout-policy.ts:8`
```typescript
DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes for cron jobs
```
- This is for background cron tasks, not inference
- Not related to the user's issue

**Watchdog Timeout:** `src/agents/cli-watchdog-defaults.ts:6`
```typescript
maxMs: 600_000; // 10 minutes
```
- Similar 10-minute watchdog limit
- May also affect long-running tasks

## Proposed Fixes

### Fix 1: Remove/Increase 10-Minute Timeout

**Option A:** Remove the timeout entirely for local providers
- Check if provider is local (ollama, vllm, llama.cpp, etc.)
- Set timeout to MAX_SAFE_TIMEOUT_MS (no timeout)

**Option B:** Increase the default timeout
- Change `DEFAULT_AGENT_TIMEOUT_SECONDS = 600` to something like `3600` (1 hour)
- Configurable via `agents.defaults.timeoutSeconds`

### Fix 2: Exclude Local Providers from Rate-Limit Detection

**Implementation:**
```typescript
const LOCAL_PROVIDERS = ["ollama", "vllm", "llama.cpp", "local"];

export function isRateLimitAssistantError(msg: AssistantMessage | undefined, provider?: string): boolean {
  // Always return false for local providers
  if (provider && LOCAL_PROVIDERS.includes(provider.toLowerCase())) {
    return false;
  }
  // ... rest of existing logic
}
```

**Apply to:**
- `isRateLimitAssistantError()` call in `run.ts`
- Pass `provider` parameter to the function
- Update function signature to accept provider

### Fix 3: Add Timeout Logging

**Implementation:**
Create a simple logging mechanism that writes to `/home/lumina/timeout.log`

**Format:**
```
[2026-03-02T08:30:00.000Z] TIMEOUT: 10-min inference killed at 600000ms
[2026-03-02T08:30:00.000Z] RATE_LIMIT: Incorrectly flagged local provider ollama
```

**Where to log:**
1. When `runAbortController.abort(makeTimeoutAbortReason())` is called
2. When `isRateLimitAssistantError()` returns true for local providers
3. When profile rotation is triggered due to timeout

## Files to Modify

1. **`src/agents/timeout.ts`** - Increase default timeout or make it configurable
2. **`src/agents/pi-embedded-helpers/errors.ts`** - Add provider check to rate-limit detection
3. **`src/agents/pi-embedded-runner/run.ts`** - Pass provider to rate-limit check
4. **`src/agents/pi-embedded-runner/run/attempt.ts`** - Add logging when timeout occurs
5. **`src/agents/pi-embedded-runner/logger.ts`** - Add timeout-specific logging function

## Testing Strategy

1. **Test timeout removal:**
   - Run a long prompt that generates 80k+ tokens
   - Verify task completes without "srv stop: cancel task" error

2. **Test rate-limit exclusion:**
   - Simulate a rate-limit error from local provider
   - Verify no profile rotation occurs

3. **Test logging:**
   - Trigger timeout condition
   - Verify log entries in `/home/lumina/timeout.log`

## Next Steps

1. ✅ Document findings (this file)
2. ⏳ Add minimal timeout logging to `/home/lumina/timeout.log`
3. ⏳ Implement Fix 1 (remove/increase timeout)
4. ⏳ Implement Fix 2 (exclude local providers from rate-limit detection)
5. ⏳ Test fixes with long-running inference tasks

---

*Last updated: 2026-03-02*

---

## Status

### Completed ✅
1. Documented timeout issues in `freeclaw/timeout-exploration.md`
2. Created timeout logging utility in `freeclaw/timeout-logger.js`
3. Added logging to attempt.ts when timeout occurs
4. Committed changes to `freeclaw` branch

### Pending ⏳
1. Implement Fix 1: Increase/remove 10-minute default timeout
2. Implement Fix 2: Exclude local providers from rate-limit detection
3. Test fixes with long-running inference tasks

## Git Commits

- `0d22f92cd` - Document timeout issues for local inference
- `0999a79c5` - Add timeout logging utility  
- `d90390c7d` - Add timeout logging when inference is killed
