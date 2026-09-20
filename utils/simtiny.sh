#!/bin/bash
# Gentle context-growth driver for the tiny sim model (e.g. Qwen3.5-0.8B).
# Each turn asks for ONE explicit read call plus a one-sentence reply.
# The simclaw agent is expected to be locked to read-only tools
# (agents.list[].tools.allow = ["read"]), so the model cannot damage anything.
#
# Usage: simtiny.sh [session-id]
# Env:   SIM_AGENT   — isolated agent command (default: simclaw)
#        SIM_RUN_DIR — output dir (default: ~/code/freeclaw-pruning-handover/runs)
#        SIM_TARGET  — file the model is told to read
#                      (default: ~/.simclaw/workspace/corpus.txt, a synthetic
#                      line corpus the model cannot know, forcing a real read
#                      call instead of answering from memory)
#
# Use a FRESH session id per experiment run.
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null
SESSION="${1:-${SIM_SESSION:-sim-T}}"
AGENT="${SIM_AGENT:-simclaw}"
S="${SIM_RUN_DIR:-$HOME/code/freeclaw-pruning-handover/runs}"
mkdir -p "$S"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
TARGET="${SIM_TARGET:-$HOME/.simclaw/workspace/corpus.txt}"
SESSION_FILE="$HOME/.$AGENT/agents/main/sessions/$SESSION.jsonl"
if [ -f "$SESSION_FILE" ]; then
  echo "WARNING: $SESSION_FILE already exists — turns append to that session" >&2
fi

MSGS=()
off=1
for i in $(seq 1 24); do
  MSGS+=("Call the read tool now with path=$TARGET, offset=$off, limit=1200. Always call read for this turn's offset, never answer from memory. Then reply with only the first line you received.")
  off=$((off + 1200))
done

i=0
for m in "${MSGS[@]}"; do
  i=$((i+1))
  t0=$(date +%s)
  "$AGENT" agent --session-id "$SESSION" --message "$m" --timeout 1200 --json > "$S/tiny-$SESSION-turn-$i.json" 2>&1
  rc=$?
  printf '%s turn=%d rc=%s wall=%ss\n' "$(date +%H:%M:%S)" "$i" "$rc" "$(( $(date +%s) - t0 ))"
  python3 "$SCRIPT_DIR/simwatch.py" "$SESSION" > "$S/simwatch-$SESSION-after-$i.txt" 2>&1
  tail -2 "$S/simwatch-$SESSION-after-$i.txt"
done
echo DONE
