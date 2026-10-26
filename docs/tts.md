---
summary: "Text-to-speech (TTS) for outbound replies with local Qwen3 or Kokoro"
read_when:
  - Enabling text-to-speech for replies
  - Configuring TTS providers or limits
  - Using /tts commands
title: "Text-to-Speech"
---

# Text-to-speech (TTS)

OpenClaw can turn outbound replies into audio with one of two **local** TTS providers.
Both run on the gateway host. No API key is needed and no text leaves the machine.
It works anywhere OpenClaw can send audio; Telegram, WhatsApp and Feishu get a voice-note bubble.

## Providers

| Provider | Model                                                                | Hardware                    | Best for                       |
| -------- | -------------------------------------------------------------------- | --------------------------- | ------------------------------ |
| `qwen3`  | Qwen3-TTS 1.7B VoiceDesign                                           | CUDA GPU (CPU is very slow) | Hosts with an NVIDIA GPU       |
| `kokoro` | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0) | CPU, real-time on a laptop  | CPU-only hosts, integrated GPU |

Both providers work the same way: OpenClaw runs a Python script that you install,
the script writes a WAV file, and OpenClaw converts it with `ffmpeg` to Opus (voice-note channels)
or MP3 (everything else). `ffmpeg` must be on the gateway's `PATH`.

ElevenLabs, OpenAI and Edge TTS are **not** selectable. Old configs that name them
still validate, but OpenClaw ignores those providers and uses the local ones instead.
`/tts provider` and the gateway `tts.setProvider` method refuse them.

### Which one should I use?

- **No CUDA GPU** (laptop, mini PC, VPS, Intel/AMD integrated graphics): use `kokoro`.
  It runs in real time on a laptop-class CPU.
- **NVIDIA GPU with CUDA**: use `qwen3`. It is larger and slower to start, but you can
  describe the voice in plain language (`instruct`).
- You can enable both. The selected provider is tried first and the other one is
  used as a fallback (see [Fallback](#fallback)).

## Is it enabled by default?

No. Auto-TTS is **off** by default, and both providers are disabled
(`enabled: false`) until you configure them. Enable auto-TTS in config with
`messages.tts.auto`, or on this host with `/tts on` (stored in the local prefs file).

## Config

TTS config lives under `messages.tts` in `openclaw.json`.
Full schema is in [Gateway configuration](/gateway/configuration).

### Kokoro (CPU)

Install the reference script first. It is in the repo at `scripts/tts/kokoro_tts.py`;
see `scripts/tts/README.md` for the full steps. In short:

```bash
python3 -m venv /opt/kokoro/venv
/opt/kokoro/venv/bin/pip install kokoro soundfile
sudo apt install espeak-ng   # fallback for out-of-vocabulary words
cp scripts/tts/kokoro_tts.py /opt/kokoro/
```

The first run downloads the model weights to the Hugging Face cache.

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "kokoro",
      kokoro: {
        enabled: true,
        scriptPath: "/opt/kokoro/kokoro_tts.py",
        python: "/opt/kokoro/venv/bin/python",
        voice: "af_heart",
        lang: "a",
        speed: 1.0,
        timeoutMs: 60000,
      },
    },
  },
}
```

OpenClaw runs:

```
<python> <scriptPath> --text <text> --output <file.wav> --voice <voice> --lang <lang> --speed <speed>
```

### Qwen3 (GPU)

You supply the Qwen3-TTS script and its Python environment; no Qwen3 script ships in this repo.

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "qwen3",
      qwen3: {
        enabled: true,
        scriptPath: "/opt/qwen3-tts/qwen3_tts.py",
        model: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        instruct: "A calm, friendly female voice with clear diction.",
        language: "English",
        device: "cuda:0",
        maxNewTokens: 2048,
        timeoutMs: 120000,
      },
    },
  },
}
```

OpenClaw runs:

```
<python> <scriptPath> --text <text> --output <file.wav> --instruct <instruct> --language <language>
  --device <device> --model <model> --max-new-tokens <maxNewTokens>
```

The interpreter for qwen3 comes from `QWEN3_TTS_PYTHON`, then `PYTHON`, then `python3`.

### Both, with fallback

On a host with a GPU, you can use qwen3 and keep kokoro as a CPU fallback:

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "qwen3",
      qwen3: { enabled: true, scriptPath: "/opt/qwen3-tts/qwen3_tts.py" },
      kokoro: {
        enabled: true,
        scriptPath: "/opt/kokoro/kokoro_tts.py",
        python: "/opt/kokoro/venv/bin/python",
      },
    },
  },
}
```

### Custom limits + prefs path

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### Only reply with audio after an inbound voice note

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Disable auto-summary for long replies

Run:

```
/tts summary off
```

### Notes on fields

General:

- `auto`: auto-TTS mode (`off`, `always`, `inbound`, `tagged`).
  - `inbound` only sends audio after an inbound voice note.
  - `tagged` only sends audio when the reply includes `[[tts]]` tags.
- `enabled`: legacy toggle (doctor migrates this to `auto`).
- `mode`: `"final"` (default) or `"all"` (includes tool/block replies).
- `provider`: `"qwen3"` or `"kokoro"`. If unset (or set to a legacy cloud provider), `qwen3` is
  the primary and `kokoro` the fallback.
- `summaryModel`: optional cheap model for auto-summary; defaults to `agents.defaults.model.primary`.
  - Accepts `provider/model` or a configured model alias.
  - Summaries use your chat model provider, so if that is a cloud model the reply text goes there
    for summarizing (the audio is still generated locally). Turn summaries off with `/tts summary off`.
- `modelOverrides`: allow the model to emit TTS directives (on by default).
  - `allowProvider` defaults to `false` (provider switching is opt-in).
- `maxTextLength`: hard cap for TTS input (chars). `/tts audio` fails if exceeded.
- `timeoutMs`: timeout for the auto-summary call (ms). Each local provider has its own `timeoutMs`.
- `prefsPath`: override the local prefs JSON path (provider/limit/summary).

`kokoro`:

- `enabled`: default `false`.
- `scriptPath`: path to the Kokoro script. Falls back to `KOKORO_TTS_SCRIPT`.
- `python`: interpreter used to run the script. Falls back to `KOKORO_TTS_PYTHON`, then `PYTHON`,
  then `python3`. Point it at the venv's `bin/python`.
- `voice`: Kokoro voice id, default `af_heart`. Examples: `af_bella`, `am_michael` (American),
  `bf_emma`, `bm_george` (British).
- `lang`: `a` = American English (default), `b` = British English. Match it to the voice prefix.
- `speed`: `0.5..2.0`, default `1.0`.
- `timeoutMs`: `1000..600000`, default `60000`. The first call after a restart loads the model,
  so leave room for that.

`qwen3`:

- `enabled`: default `false`.
- `scriptPath`: path to your Qwen3-TTS script. Falls back to `QWEN3_TTS_SCRIPT`.
- `model`: Hugging Face id or local path (default `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`).
- `instruct`: natural-language voice description.
- `language`: output language (default `English`).
- `device`: torch device (default `cuda:0`).
- `maxNewTokens`: generation cap (default `2048`).
- `timeoutMs`: `1000..600000`, default `30000`.

Paths in `scriptPath` and `python` are used as given; `~` is not expanded.

## Fallback

The selected provider runs first, then the other local provider. A provider that is
disabled or has no `scriptPath` is skipped, and the reason shows up in the error if
both fail, for example:

```
TTS conversion failed: kokoro: disabled; qwen3: scriptPath not configured
```

If a script exits non-zero, the last lines of its stderr are included in the error
(`kokoro: Kokoro-TTS failed (exit 1): kokoro_tts: ...`). If it runs past `timeoutMs`, it is
killed and the next provider is tried.

## Model-driven overrides (default on)

By default, the model **can** emit TTS directives for a single reply.
When `messages.tts.auto` is `tagged`, these directives are required to trigger audio.

The model can add an optional `[[tts:text]]...[[/tts:text]]` block with text that
should only be spoken, not shown:

```
Here you go.

[[tts:text]]Here is the summary you asked for.[[/tts:text]]
```

`[[tts:provider=kokoro]]` or `[[tts:provider=qwen3]]` switches the provider for one reply,
but only when `modelOverrides.allowProvider: true`. Other providers are ignored with a warning.

The voice, model, speed and ElevenLabs-style directive keys (`voice`, `voiceId`, `model`,
`stability`, `seed`, ...) are still parsed but have no effect on the local providers; set the
voice in config instead.

Disable all model overrides:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

## Per-user preferences

Slash commands write local overrides to `prefsPath` (default:
`~/.openclaw/settings/tts.json`, override with `OPENCLAW_TTS_PREFS` or
`messages.tts.prefsPath`).

Stored fields:

- `auto`
- `provider` (`qwen3` or `kokoro`)
- `maxLength` (summary threshold; default 1500 chars)
- `summarize` (default `true`)

These override `messages.tts.*` for that host.

## Output formats

Both providers write WAV, which OpenClaw converts with `ffmpeg`:

- **Telegram, WhatsApp, Feishu**: Opus, mono, 48 kHz, 64 kbps, sent as a voice note.
- **Other channels** (Signal, Discord, Slack, ...): MP3, 128 kbps.

Telephony (voice-call) TTS is not supported by the local providers.

## Auto-TTS behavior

When enabled, OpenClaw:

- skips TTS if the reply already contains media or a `MEDIA:` directive.
- skips very short replies (< 10 chars).
- summarizes long replies when enabled using `agents.defaults.model.primary` (or `summaryModel`).
- strips Markdown before speaking.
- attaches the generated audio to the reply.

If the reply exceeds `maxLength` and summary is off, the text is truncated before
it is spoken. If the summary fails, the text is truncated as well.

## Flow diagram

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> truncate -> TTS -> attach audio
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## Slash command usage

There is a single command: `/tts`.
See [Slash commands](/tools/slash-commands) for enablement details.

Discord note: `/tts` is a built-in Discord command, so OpenClaw registers
`/voice` as the native command there. Text `/tts ...` still works.

```
/tts on
/tts off
/tts status
/tts provider
/tts provider kokoro
/tts provider qwen3
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

Notes:

- Commands require an authorized sender (allowlist/owner rules still apply).
- `commands.text` or native command registration must be enabled.
- `/tts on` sets auto-TTS to `always` and `/tts off` sets it to `off`, in the local prefs file. For
  `inbound` or `tagged`, set `messages.tts.auto` in config.
- `/tts provider` with no argument shows the primary and whether each local provider is configured.
- `provider`, `limit` and `summary` are stored in local prefs, not the main config.
- `/tts audio` generates a one-off audio reply (does not toggle TTS on).

## Agent tool

The `tts` tool converts text to speech and returns a `MEDIA:` path. When the
result is voice-note compatible (Opus), the tool includes `[[audio_as_voice]]` so
the channel sends a voice bubble. If the tool says `kokoro: disabled; qwen3: disabled`,
no provider is enabled on that host yet.

## Gateway RPC

Gateway methods:

- `tts.status`: state, primary provider, configured fallback providers, `qwen3Configured`, `kokoroConfigured`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`: accepts `qwen3` or `kokoro`
- `tts.providers`: lists `qwen3` and `kokoro` with their configured state
