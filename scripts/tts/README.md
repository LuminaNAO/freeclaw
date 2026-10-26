# Local TTS scripts

## Kokoro (`kokoro_tts.py`)

Reference script for the `kokoro` TTS provider. It runs
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0, ~82M parameters)
fully on the local machine and is fast enough for real-time speech on a laptop-class CPU.
No GPU is needed and no text leaves the machine.

The script takes exactly these arguments and writes a 24 kHz mono WAV:

```bash
kokoro_tts.py --text "Hello there" --output /tmp/hello.wav --voice af_heart --lang a --speed 1.0
```

On failure it prints one line to stderr and exits non-zero; OpenClaw shows that line in
the TTS error.

### Install

Use a dedicated virtual environment so the packages stay out of the system Python:

```bash
python3 -m venv /opt/kokoro/venv
/opt/kokoro/venv/bin/pip install kokoro soundfile
```

Install `espeak-ng` from your distro as well. Kokoro uses it as a fallback for
out-of-vocabulary words (names, rare words):

```bash
sudo apt install espeak-ng     # Debian/Ubuntu
sudo pacman -S espeak-ng       # Arch
sudo dnf install espeak-ng     # Fedora
```

The first run downloads the model weights and voice files to the Hugging Face cache
(`~/.cache/huggingface` by default). Run it once by hand to warm the cache:

```bash
/opt/kokoro/venv/bin/python scripts/tts/kokoro_tts.py \
  --text "Kokoro is ready." --output /tmp/kokoro-test.wav --voice af_heart --lang a --speed 1.0
```

### Point OpenClaw at it

Copy the script somewhere stable (or use it from the checkout) and set `scriptPath` to it and
`python` to the venv interpreter. Use absolute paths; `~` is not expanded:

```json5
{
  messages: {
    tts: {
      provider: "kokoro",
      kokoro: {
        enabled: true,
        scriptPath: "/opt/kokoro/kokoro_tts.py",
        python: "/opt/kokoro/venv/bin/python",
        voice: "af_heart", // e.g. af_bella, am_michael, bf_emma, bm_george
        lang: "a", // "a" = American English, "b" = British English
        speed: 1.0,
      },
    },
  },
}
```

Instead of config you can set `KOKORO_TTS_SCRIPT` and `KOKORO_TTS_PYTHON` in the gateway
environment. Config wins over the environment; when neither sets the interpreter,
`PYTHON` and then `python3` are used.

Pick a voice that matches `lang`: `a*` voices are American English, `b*` voices British.
