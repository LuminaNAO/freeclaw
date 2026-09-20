#!/usr/bin/env python3
"""Per-request view of the simulation sessions from llama.log + llama-deep.log:
body bytes, tokens prefilled vs cached, context depth, trigger, and which
FreeClaw trimming placeholders appear in the request body.

Usage: simwatch.py [session-substring]   (default: "simclaw")
Env:   LLAMA_LOG / LLAMA_DEEP_LOG override the log paths.
"""
import re, sys, os

LOG = os.environ.get("LLAMA_LOG", os.path.expanduser("~/code/llama-launcher/llama.log"))
DEEP = os.environ.get("LLAMA_DEEP_LOG", os.path.expanduser("~/code/llama-launcher/llama-deep.log"))
SUMMARY = "--summary" in sys.argv
KEY = next((a for a in sys.argv[1:] if not a.startswith("--")), "simclaw")
REPREFILL_MIN_TOKENS = 8_000
ANSI = re.compile(r"\x1b\[[0-9;]*m")

MARKERS = {
    "guard": "[compacted: tool output removed to free context]",
    "pruned": "[pruned: ",
    "trunc": "[truncated: output exceeded context limit]",
    "hardclear": "[Old tool result content cleared]",
    "softtrim": "[Tool result trimmed:",
    "compaction": "summary of the conversation",
}

rows = []
cur = None
for line in open(LOG, errors="replace"):
    line = ANSI.sub("", line.rstrip("\n"))
    if line.startswith("REQUEST "):
        if KEY.lower() not in line.lower():
            cur = None
            continue
        m = re.search(r"body_bytes=(\d+).*?session=(\S+).*?cache=(\S+) access=(\S+)(?: trigger=(\S+))?", line)
        cur = {"body": int(m.group(1)), "session": m.group(2)[-24:], "cache": m.group(3),
               "access": m.group(4), "trigger": m.group(5) or "-", "prompt_n": None, "n_tokens": None}
        rows.append(cur)
    elif cur is not None:
        m = re.search(r"prompt eval time = +([\d.]+) ms / +(\d+) tokens", line)
        if m and cur["prompt_n"] is None:
            cur["prompt_n"] = int(m.group(2)); cur["pp_s"] = round(float(m.group(1)) / 1000, 1)
        m = re.search(r"stop processing: n_tokens = (\d+)", line)
        if m and cur["n_tokens"] is None:
            cur["n_tokens"] = int(m.group(1))

# deep log: blocks are ">>> POST /v1/messages" / body JSON / "REQUEST ... session=..."
marks = []
if os.path.exists(DEEP):
    lines = open(DEEP, errors="replace")
    prev_body = None
    for line in lines:
        line = ANSI.sub("", line.rstrip("\n"))
        if line.startswith(">>> POST /v1/messages"):
            prev_body = "PENDING"
        elif prev_body == "PENDING":
            prev_body = line
        elif line.startswith("REQUEST ") and prev_body not in (None, "PENDING"):
            if KEY.lower() in line.lower():
                marks.append({k: prev_body.count(v) for k, v in MARKERS.items()} | {"body_len": len(prev_body)})
            prev_body = None

print(f"{'#':>3} {'sess':<24} {'trig':<9} {'body_KB':>8} {'prompt_n':>8} {'pp_s':>6} {'n_tokens':>8}  markers(guard/trunc/hardclear/softtrim)")
for i, r in enumerate(rows):
    mk = marks[i] if i < len(marks) else None
    mks = f"{mk['guard']}/{mk['trunc']}/{mk['hardclear']}/{mk['softtrim']} deep_len={mk['body_len']}" if mk else "-"
    print(f"{i:>3} {r['session']:<24} {r['trigger']:<9} {r['body']/1024:>8.1f} {str(r['prompt_n']):>8} {str(r.get('pp_s','')):>6} {str(r['n_tokens']):>8}  {mks}")

if SUMMARY:
    # Phase-metric rollup: re-prefill events are requests that prefilled more
    # than REPREFILL_MIN_TOKENS tokens (a warm turn is < 8k). Mirrors the
    # handover's success metric: events and seconds spent in them.
    events = [r for r in rows if (r["prompt_n"] or 0) > REPREFILL_MIN_TOKENS]
    total_prompt = sum(r["prompt_n"] or 0 for r in rows)
    event_prompt = sum(r["prompt_n"] or 0 for r in events)
    event_secs = sum(r.get("pp_s") or 0 for r in events)
    depths = [r["n_tokens"] for r in rows if r["n_tokens"] is not None]
    print()
    print(f"summary for key={KEY!r}: requests={len(rows)} reprefill_events(>{REPREFILL_MIN_TOKENS})={len(events)}")
    print(f"  prompt tokens: total={total_prompt:,} in_events={event_prompt:,} ({(event_prompt / total_prompt * 100) if total_prompt else 0:.1f}%)")
    print(f"  seconds in events={event_secs:.1f}  max_depth={max(depths) if depths else 0:,}")
    if marks:
        totals = {k: sum(m[k] for m in marks) for k in MARKERS}
        print(f"  marker totals: {totals}")
