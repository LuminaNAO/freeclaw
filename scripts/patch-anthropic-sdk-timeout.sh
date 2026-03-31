#!/usr/bin/env bash
# patch-anthropic-sdk-timeout.sh
# Patches @anthropic-ai/sdk DEFAULT_TIMEOUT from 10 minutes to ~24 days.
# Local inference (llama.cpp, vllm, ollama) can take 15-20+ minutes for
# prompt processing on large contexts; the 10-minute SDK default kills
# requests mid-processing.
#
# Run after: pnpm install
# Safe to re-run (idempotent).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OLD_VALUE="BaseAnthropic.DEFAULT_TIMEOUT = 600000;"
NEW_VALUE="BaseAnthropic.DEFAULT_TIMEOUT = 2147000000; // patched for local inference (freeclaw)"

patched=0

for f in $(find "$REPO_ROOT/node_modules" -path "*/@anthropic-ai/sdk/client.js" -o -path "*/@anthropic-ai/sdk/client.mjs" 2>/dev/null); do
    if grep -q "$OLD_VALUE" "$f" 2>/dev/null; then
        sed -i "s|$OLD_VALUE|$NEW_VALUE|g" "$f"
        echo "[patch-anthropic-sdk] patched: $f"
        patched=$((patched + 1))
    elif grep -q "patched for local inference" "$f" 2>/dev/null; then
        echo "[patch-anthropic-sdk] already patched: $f"
    else
        echo "[patch-anthropic-sdk] WARNING: unexpected content in $f"
    fi
done

if [ "$patched" -eq 0 ]; then
    echo "[patch-anthropic-sdk] no files needed patching (already patched or SDK not installed)"
else
    echo "[patch-anthropic-sdk] patched $patched file(s)"
fi
