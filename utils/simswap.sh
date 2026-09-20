#!/bin/bash
# Two FreeClaw sessions on an isolated agent, alternating A/B/A/B so the
# proxy must save and restore each session's slot between turns.
#
# Usage: simswap.sh [session-A] [session-B]
# Env:   SIM_AGENT   — isolated agent command (default: simclaw)
#        SIM_RUN_DIR — output dir for per-turn JSON
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null
AGENT="${SIM_AGENT:-simclaw}"
S="${SIM_RUN_DIR:-$HOME/code/freeclaw-pruning-handover/runs}"
mkdir -p "$S"
A="${1:-sim-swap-A}"
B="${2:-sim-swap-B}"
turn() { # $1 session, $2 message
  local t0=$(date +%s.%N)
  "$AGENT" agent --session-id "$1" --message "$2" --timeout 1200 --json > "$S/turn-$1-$(date +%H%M%S).json" 2>&1
  local rc=$?
  printf '%s  %s  rc=%s  wall=%.1fs\n' "$(date +%H:%M:%S)" "$1" "$rc" "$(echo "$(date +%s.%N) - $t0" | bc)"
}
turn "$A" "Hello. In one short paragraph, explain what a KV cache is in a transformer, then list the files in your workspace."
turn "$B" "Hello. In one short paragraph, explain what speculative decoding is, then tell me today's date using a shell command."
turn "$A" "Thanks. Now in two sentences: why does prompt-prefix stability matter for a KV cache?"
turn "$B" "Thanks. Now in two sentences: what is the acceptance rate in speculative decoding?"
echo DONE
