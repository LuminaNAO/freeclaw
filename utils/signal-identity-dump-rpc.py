#!/usr/bin/env python3
"""Build a fresh signal-identity dump from the running gateway's signal-cli daemon
HTTP JSON-RPC endpoint (no account lock needed — read-only listGroups/listContacts).

Produces the same schema as signal-identity-dump.sh:
  .self / .contacts / .contacts_count / .groups / .groups_count / .generated_at
Group field mapping (RPC → dump schema):
  isMember→active, isBlocked→blocked, messageExpirationTime→message_expiration_seconds,
  groupInviteLink→group_invite_link, pendingMembers→pending_members,
  requestingMembers→requesting_members, banned→banned_members.

Also follows signal-identity-diff.sh convention: archive old current.json as
<timestamp>.json and write a unified diff to <timestamp>.diff + current.diff.
"""
import json, os, re, subprocess, sys, urllib.request
from datetime import datetime, timezone

DUMP_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "signal-identity-dumps")
ACCOUNTS = os.path.expanduser("~/.local/share/signal-cli/data/accounts.json")
def discover_rpc():
    """Find the signal-cli daemon's --http port dynamically (survives gateway restarts)."""
    try:
        ps = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True, timeout=15).stdout
        m = re.search(r"signal.*?daemon.*?--http 127\.0\.0\.1:(\d+)", ps)
        if m:
            return f"http://127.0.0.1:{m.group(1)}/api/v1/rpc"
    except Exception:
        pass
    return "http://127.0.0.1:56974/api/v1/rpc"  # legacy fallback

RPC = discover_rpc()

def rpc(method, mid):
    req = urllib.request.Request(RPC, data=json.dumps(
        {"jsonrpc": "2.0", "method": method, "params": {}, "id": mid}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    if "error" in d:
        raise SystemExit(f"RPC error {method}: {d['error']}")
    return d["result"]

now = datetime.now(timezone.utc)
ts = now.strftime("%Y-%m-%dT%H-%M-%S.%f")[:-3] + "Z"

accounts = json.load(open(ACCOUNTS))["accounts"][0]
groups_rpc = rpc("listGroups", 1)
contacts = rpc("listContacts", 2)
self_rec = next((c for c in contacts if c.get("uuid") == accounts["uuid"]), None)

def map_group(g):
    return {
        "id": g["id"],
        "name": g.get("name"),
        "description": g.get("description"),
        "active": bool(g.get("isMember", True)),
        "blocked": bool(g.get("isBlocked", False)),
        "message_expiration_seconds": g.get("messageExpirationTime", 0) or 0,
        "group_invite_link": g.get("groupInviteLink"),
        "member_count": len(g.get("members", [])),
        "members": g.get("members", []),
        "pending_members": g.get("pendingMembers", []),
        "requesting_members": g.get("requestingMembers", []),
        "banned_members": g.get("banned", []),
    }

dump = {
    "self": dict(accounts, contact_record=self_rec),
    "contacts": contacts,
    "contacts_count": len(contacts),
    "groups": [map_group(g) for g in groups_rpc],
    "groups_count": len(groups_rpc),
    "generated_at": now.isoformat(),
    "source": "signal-cli-daemon-http-rpc (live, gateway-held account — lock-free)",
}

old_path = os.path.join(DUMP_DIR, "current.json")
old_b64 = None
if os.path.exists(old_path):
    old = json.load(open(old_path))
    old_b64 = sorted(g["id"] for g in old.get("groups", []))

new_b64 = sorted(g["id"] for g in dump["groups"])
print(f"groups: old {len(old_b64 or [])} → new {len(new_b64)}")
print("added:", [g for g in new_b64 if old_b64 and g not in old_b64])
print("dropped:", [g for g in (old_b64 or []) if g not in new_b64])

# diff old vs new, archive old, install new (diff-script convention)
new_tmp = os.path.join(DUMP_DIR, "current.json.tmp")
with open(new_tmp, "w") as f:
    json.dump(dump, f, indent=2)
import difflib
if os.path.exists(old_path):
    a = open(old_path).read().splitlines()
    b = open(new_tmp).read().splitlines()
    diff_lines = list(difflib.unified_diff(a, b, "archived/current.json", "current.json", lineterm=""))
    with open(os.path.join(DUMP_DIR, f"{ts}.diff"), "w") as f:
        f.write("\n".join(diff_lines) + "\n")
    with open(os.path.join(DUMP_DIR, "current.diff"), "w") as f:
        f.write("\n".join(diff_lines) + "\n")
    os.replace(old_path, os.path.join(DUMP_DIR, f"{ts}.json"))
    print("archived old dump →", f"{ts}.json")
else:
    with open(os.path.join(DUMP_DIR, f"{ts}.diff"), "w") as f:
        f.write("# no previous dump to diff against\n")
    print("no prior dump")
os.replace(new_tmp, old_path)
print("fresh current.json installed (live daemon source)")
