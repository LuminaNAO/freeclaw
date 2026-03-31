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

# ── Part 1b: Patch hardcoded 600000 fallback in messages resources ─────────
# The SDK's messages.create() has `timeout: timeout ?? 600000` which bypasses
# DEFAULT_TIMEOUT when _options.timeout is undefined (no explicit timeout
# passed to constructor). This hardcoded 10-minute fallback kills requests
# during long prompt processing.

MSG_OLD="timeout: timeout ?? 600000,"
MSG_NEW="timeout: timeout ?? 2147000000, // patched for local inference (freeclaw)"

msg_patched=0

for f in $(find "$REPO_ROOT/node_modules" -path "*/@anthropic-ai/sdk/resources/*/messages.js" -o -path "*/@anthropic-ai/sdk/resources/*/messages.mjs" 2>/dev/null); do
    if grep -q "$MSG_OLD" "$f" 2>/dev/null; then
        sed -i "s|$MSG_OLD|$MSG_NEW|g" "$f"
        echo "[patch-anthropic-sdk-msg] patched: $f"
        msg_patched=$((msg_patched + 1))
    elif grep -q "patched for local inference" "$f" 2>/dev/null; then
        echo "[patch-anthropic-sdk-msg] already patched: $f"
    fi
done

if [ "$msg_patched" -eq 0 ]; then
    echo "[patch-anthropic-sdk-msg] no files needed patching"
else
    echo "[patch-anthropic-sdk-msg] patched $msg_patched file(s)"
fi

# ── Part 2: Patch undici bodyTimeout / headersTimeout ──────────────────────
# undici (Node.js built-in fetch HTTP client) defaults bodyTimeout and
# headersTimeout to 300,000ms (5 minutes). During local inference, llama.cpp
# may send no SSE events for 15-20+ minutes while processing large prompts.
# The idle body timeout kills the connection mid-processing.

UNDICI_OLD_BODY="bodyTimeout != null ? bodyTimeout : 300e3"
UNDICI_NEW_BODY="bodyTimeout != null ? bodyTimeout : 0 /* patched for local inference (freeclaw) */"
UNDICI_OLD_HDRS="headersTimeout != null ? headersTimeout : 300e3"
UNDICI_NEW_HDRS="headersTimeout != null ? headersTimeout : 0 /* patched for local inference (freeclaw) */"

undici_patched=0

for f in $(find "$REPO_ROOT/node_modules" -path "*/undici/lib/dispatcher/client.js" 2>/dev/null); do
    changed=0
    if grep -q "$UNDICI_OLD_BODY" "$f" 2>/dev/null; then
        sed -i "s|$UNDICI_OLD_BODY|$UNDICI_NEW_BODY|g" "$f"
        changed=1
    fi
    if grep -q "$UNDICI_OLD_HDRS" "$f" 2>/dev/null; then
        sed -i "s|$UNDICI_OLD_HDRS|$UNDICI_NEW_HDRS|g" "$f"
        changed=1
    fi
    if [ "$changed" -eq 1 ]; then
        echo "[patch-undici] patched: $f"
        undici_patched=$((undici_patched + 1))
    elif grep -q "patched for local inference" "$f" 2>/dev/null; then
        echo "[patch-undici] already patched: $f"
    else
        echo "[patch-undici] WARNING: unexpected content in $f"
    fi
done

if [ "$undici_patched" -eq 0 ]; then
    echo "[patch-undici] no files needed patching (already patched or undici not installed)"
else
    echo "[patch-undici] patched $undici_patched file(s)"
fi

# ── Part 3: Inject patched undici fetch into pi-ai Anthropic provider ──────
# The Anthropic SDK uses globalThis.fetch (Node's built-in fetch), which has
# its own internal undici with hardcoded bodyTimeout=300s. Patching the npm
# undici package doesn't affect the built-in fetch. We must inject the npm
# undici's fetch function explicitly so the patched timeouts take effect.

PIIA_IMPORT_OLD='import Anthropic from "@anthropic-ai/sdk";'
PIIA_IMPORT_NEW='import Anthropic from "@anthropic-ai/sdk";\nimport { fetch as undiciFetch } from "undici"; // [freeclaw] patched undici with no bodyTimeout'

PIIA_CLIENT_OLD='        baseURL: model.baseUrl,\n        dangerouslyAllowBrowser: true,'
PIIA_CLIENT_NEW='        baseURL: model.baseUrl,\n        fetch: undiciFetch, // [freeclaw] use patched undici with no bodyTimeout\n        dangerouslyAllowBrowser: true,'

piia_patched=0

for f in $(find "$REPO_ROOT/node_modules" -path "*/@mariozechner/pi-ai/dist/providers/anthropic.js" 2>/dev/null); do
    changed=0
    if grep -q 'import Anthropic from "@anthropic-ai/sdk";' "$f" 2>/dev/null && ! grep -q 'undiciFetch' "$f" 2>/dev/null; then
        # Add undici import
        sed -i '1s|import Anthropic from "@anthropic-ai/sdk";|import Anthropic from "@anthropic-ai/sdk";\nimport { fetch as undiciFetch } from "undici"; // [freeclaw] patched undici with no bodyTimeout|' "$f"
        # Add fetch option to all Anthropic client constructors
        sed -i 's|        baseURL: model.baseUrl,$|        baseURL: model.baseUrl,\n        fetch: undiciFetch, // [freeclaw] use patched undici with no bodyTimeout|' "$f"
        echo "[patch-pi-ai] patched: $f"
        piia_patched=$((piia_patched + 1))
    elif grep -q 'undiciFetch' "$f" 2>/dev/null; then
        echo "[patch-pi-ai] already patched: $f"
    else
        echo "[patch-pi-ai] WARNING: unexpected content in $f"
    fi
done

if [ "$piia_patched" -eq 0 ]; then
    echo "[patch-pi-ai] no files needed patching (already patched or pi-ai not installed)"
else
    echo "[patch-pi-ai] patched $piia_patched file(s)"
fi
