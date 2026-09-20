#!/bin/bash
# Drive one FreeClaw session through a real agentic coding project so the
# context grows to the 200k+ region; snapshot the per-request table after
# every turn to see when tool results get trimmed and when compaction fires.
#
# Usage: simlong.sh [session-id]
# Env:   SIM_AGENT   — isolated agent command (default: simclaw)
#        SIM_RUN_DIR — output dir for per-turn JSON + watcher snapshots
#                      (default: ~/code/freeclaw-pruning-handover/runs)
#
# Use a FRESH session id per experiment run: the driver appends turns, so an
# existing session starts deep in context and is not comparable to earlier
# baselines.
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null
SESSION="${1:-${SIM_SESSION:-sim-A}}"
AGENT="${SIM_AGENT:-simclaw}"
S="${SIM_RUN_DIR:-$HOME/code/freeclaw-pruning-handover/runs}"
mkdir -p "$S"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
SESSION_FILE="$HOME/.$AGENT/agents/main/sessions/$SESSION.jsonl"
if [ -f "$SESSION_FILE" ]; then
  echo "WARNING: $SESSION_FILE already exists — turns append to that session" >&2
fi
LOG=$HOME/code/llama-launcher/llama.log
PROXY=$HOME/code/llama-launcher/llama-deep-proxy.mjs
SERVER=$HOME/code/llama-hdd.cpp/tools/server/server-context.cpp
MSGS=(
"We are starting a real coding project in your workspace. Create a Python package called slotstat (directory slotstat/ with pyproject.toml, src layout, and tests/). Purpose: parse the llama-launcher log at $LOG and report, per session, every request's body bytes, prompt tokens processed, cached tokens, context depth, and every HDD CACHE save/restore with its byte count. First read the proxy source at $PROXY to learn the exact line formats it writes (REQUEST lines and HDD CACHE lines), then read the first 400 lines of the log to see real samples. Then write the parser module, a CLI (python -m slotstat <logfile>) and pytest tests using small fixture strings. Run the tests and show me the summary."
"Now run the real CLI against $LOG and show me the first 30 output lines. Fix any parser bugs you hit. Make sure ANSI colour codes are stripped before matching."
"Add a --json flag that emits one JSON object per request, and a --session <substring> filter. Add tests for both. Run the tests."
"Add a 'sessions' subcommand that prints one row per session: request count, max context depth, total prompt tokens processed, total cached tokens, number of saves, number of restores, bytes written, bytes read. Test it on the real log and paste the top 15 rows."
"Read $SERVER lines 3380 to 3560 (the prompt cache reuse logic) and write docs/cache-reuse.md explaining in your own words how n_past and the common prefix are computed, and how that shows up in the log lines slotstat parses."
"Add a 'timeline' subcommand: for one session (--session), print each request with the wall-clock time, the prompt tokens, and whether it was a cache hit (cached > 90 percent of depth) or a semi-cold or cold prefill. Test it against the real log on the busiest session."
"Refactor: split the parser into parser.py, model.py (dataclasses) and report.py. Keep the tests green. Add type hints everywhere and run python -m mypy if available, otherwise python -m compileall."
"Add a --since HH:MM filter using the log timestamps and a --csv output for the sessions subcommand. Tests for both. Run everything."
"Write a README.md for slotstat with install and usage instructions and three worked examples with real output from $LOG."
"Add a 'saves' subcommand summarising HDD CACHE saves and restores: count, total bytes, mean bytes, largest, and the checkpoint sidecar sizes if present. Run it on the real log."
"Now read $PROXY again from line 700 to line 1000 and document in docs/proxy-slot-policy.md how the proxy decides between persistent, read-only and bypass access, quoting the relevant code."
"Add unit tests for every branch of the access-policy logic you just documented, as a pure-Python reimplementation in slotstat/policy.py, and run them."
"Run the full test suite with -v and paste the complete output. Then run the CLI sessions subcommand once more and paste the full table."
"Add a 'histogram' subcommand: bucket prompt tokens processed per request into 0-1k, 1k-4k, 4k-16k, 16k-64k, 64k+ and print counts and percentages, overall and per session. Tests. Run on the real log."
"Read $SERVER lines 1 to 200 and lines 2800 to 3000 and summarise in docs/server-notes.md what data structures the server keeps per slot."
"Final pass: run ruff or flake8 if available, fix warnings, run the whole suite, and give me a summary of the package layout with line counts per file."
"One more feature: a 'compare' subcommand that takes two session substrings and prints their metrics side by side. Tests. Run it on the two busiest sessions."
"Please review all the code you wrote for bugs and edge cases: empty log, log without proxy lines, truncated last line. Add tests for those and fix what you find."
"Print the full contents of every file under slotstat/src so I can review them."
"Now add docs/CHANGELOG.md summarising everything done in this session, and print it."
)
i=0
for m in "${MSGS[@]}"; do
  i=$((i+1))
  t0=$(date +%s)
  "$AGENT" agent --session-id "$SESSION" --message "$m" --timeout 3600 --json > "$S/long-turn-$i.json" 2>&1
  rc=$?
  printf '%s turn=%d rc=%s wall=%ss\n' "$(date +%H:%M:%S)" "$i" "$rc" "$(( $(date +%s) - t0 ))"
  python3 "$SCRIPT_DIR/simwatch.py" "$SESSION" > "$S/simwatch-after-$i.txt" 2>&1
  tail -3 "$S/simwatch-after-$i.txt"
done
echo DONE
