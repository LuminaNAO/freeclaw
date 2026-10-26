---
summary: "Local Kokoro TTS provider (ARCH, operator-owned)"
title: "Local Kokoro TTS provider"
---

# Local Kokoro TTS provider — ARCH (operator)

Owned by the operator; engineers never edit this file. Every commit names the section it implements.

## 1. Why
The only enabled TTS provider is `qwen3` (local, GPU, 1.7B). Agents on CPU-only boxes (integrated GPU, no CUDA) have a
`tts` tool that always fails ("qwen3: disabled"). Add a second fully local provider that runs well on a laptop-class
CPU: **Kokoro-82M** (Apache 2.0, ~82M params, English voices, CPU real-time). Nothing leaves the box.

## 2. Provider `kokoro`
1. `TtsProvider` / `TtsProviderSchema` gain `"kokoro"`. `TTS_PROVIDERS` becomes `["qwen3", "kokoro"]`; provider
   selection (prefs, config, `/tts provider`, gateway tts methods) allows both, still refuses elevenlabs/openai/edge
   (unchanged restriction).
2. Config `messages.tts.kokoro` (strict schema):
   `enabled` (bool, default false), `scriptPath` (string; env fallback `KOKORO_TTS_SCRIPT`), `python` (string; env
   fallback `KOKORO_TTS_PYTHON`, then `PYTHON`, then `python3`), `voice` (default `af_heart`), `lang` (default
   `a` = American English; `b` = British), `speed` (number 0.5-2.0, default 1.0), `timeoutMs` (1000-600000, default
   60000).
3. Runtime: same shape as qwen3: spawn `<python> <scriptPath> --text <t> --output <wav> --voice <v> --lang <l>
   --speed <s>`, wait with timeout, then the existing WAV -> opus (voice-compatible channels) / mp3 conversion and
   cleanup. Errors are reported like qwen3 (`kokoro: disabled`, `kokoro: scriptPath not configured`, script stderr
   tail on failure). Share the spawn/convert code with qwen3 rather than copying it.
4. Provider order: the configured/pref provider first, then the other enabled local provider as fallback; a
   provider that is not enabled is skipped with its reason, as today.
5. Reference script shipped in the repo at `scripts/tts/kokoro_tts.py`: uses the `kokoro` Python package
   (`KPipeline`), writes 24 kHz mono WAV, accepts exactly the args in §2.3, exits non-zero with a one-line error.
   Plus `scripts/tts/README.md`: install with a venv (`python -m venv`, `pip install kokoro soundfile`; espeak-ng
   from the distro for out-of-vocabulary words), first run downloads the weights to the HF cache, and how to point
   `scriptPath`/`python` at it.

## 3. Default voice description (qwen3)
Unchanged here: the qwen3 default `instruct` was already updated upstream (8a01fe2ed2). Do not touch it.

## 4. Docs
`docs/tts.md` is rewritten to match the code: the enabled providers are qwen3 and kokoro (both local); config
examples for each; CPU vs GPU guidance (kokoro for CPU-only boxes, qwen3 when a CUDA GPU is present). Remove the
claims that ElevenLabs/OpenAI/Edge are selectable.

## 5. Tests
- Schema: `kokoro` block accepted/strict, ranges enforced, provider enum.
- Provider selection: kokoro selectable via prefs/config/command; edge/openai/elevenlabs still refused.
- Runtime with a fake script (a tiny node/python stub that writes a valid WAV): success path -> opus for a
  voice-compatible channel, mp3 otherwise; disabled; no scriptPath; script exits non-zero (stderr surfaced);
  timeout kills the child; fallback from a disabled primary to the enabled other provider.
- No test downloads a model or needs Python packages.

## 6. Acceptance
Touched suites green, `pnpm build` green. With the reference script installed in a venv on a CPU-only box,
`messages.tts.kokoro.enabled: true` + `scriptPath` makes the `tts` tool return a playable voice note in Signal.
