#!/bin/bash
# Drive llamacpp-init interactively for an isolated agent (default: simclaw).
# llamacpp-init needs a TTY to auto-detect the native context window from
# /props instead of demanding MODEL_CONTEXT_WINDOW.
# Answers: context window -> Enter (accept detected native value),
#          subagent host/port -> Enter, Enter (same server),
#          gateway access -> 1 (loopback).
#
# Usage: sim-init.sh [agent-name]
# Env:   LLAMA_CPP_BASE_URL — inference endpoint to bind to
#        (default http://127.0.0.1:40901, the test/sim instance; production
#        is 40801).
set -e
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null
AGENT="${1:-simclaw}"
export LLAMA_CPP_BASE_URL="${LLAMA_CPP_BASE_URL:-http://127.0.0.1:40901}"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
printf '\n\n\n1\n' | script -qefc "bash \"$SCRIPT_DIR/llamacpp-init.sh\" \"$AGENT\"" /dev/null
