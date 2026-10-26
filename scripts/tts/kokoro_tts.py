#!/usr/bin/env python3
"""Reference Kokoro-82M TTS script for the OpenClaw `kokoro` provider.

Usage:
  kokoro_tts.py --text TEXT --output OUT.wav --voice af_heart --lang a --speed 1.0

Writes a 24 kHz mono 16-bit WAV to --output. On failure prints a single-line
error to stderr and exits non-zero. Requires the `kokoro` and `soundfile`
packages (see README.md in this directory).
"""

import argparse
import sys

SAMPLE_RATE = 24000


def fail(message: str, code: int = 1) -> None:
    line = " ".join(str(message).split())
    print(f"kokoro_tts: {line}", file=sys.stderr)
    sys.exit(code)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Kokoro-82M text-to-speech to WAV")
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--lang", required=True)
    parser.add_argument("--speed", required=True, type=float)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    text = args.text.strip()
    if not text:
        fail("empty --text", 2)
    if not 0.5 <= args.speed <= 2.0:
        fail(f"--speed must be between 0.5 and 2.0 (got {args.speed})", 2)

    try:
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline
    except Exception as err:  # noqa: BLE001
        fail(f"missing Python dependency ({err}); install with: pip install kokoro soundfile")

    try:
        pipeline = KPipeline(lang_code=args.lang)
        chunks = []
        for _graphemes, _phonemes, audio in pipeline(text, voice=args.voice, speed=args.speed):
            if audio is None:
                continue
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            chunks.append(np.asarray(audio, dtype=np.float32).reshape(-1))
        if not chunks:
            fail("no audio generated")
        samples = np.concatenate(chunks)
        sf.write(args.output, samples, SAMPLE_RATE, subtype="PCM_16", format="WAV")
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        fail(f"{type(err).__name__}: {err}")


if __name__ == "__main__":
    main()
