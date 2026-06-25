#!/usr/bin/env python3
"""
trustgraph.py — Build Lumina's L3 Trust Graph from Signal identity dump.

Designed to run during sleep cycle Stage 2 (The Scholar), not during active sessions.

Usage:
    python3 trustgraph.py <workspace> [--dump <path>] [--dry-run]

Reads: signal identity dump (JSON)
Outputs: trustgraph.yaml (L3 social memory)

Schema:
    Primary key: Signal UUID (uuid:xxxx)
    Trust scale: 0=unknown, 1=introduced, 2=brief, 3=working, 4=demonstrated, 5=deep trust
    Fields: name, first_seen, last_seen, trust, nature, preferences, expertise, history, contact
"""

import argparse
import datetime
import json
import os
import sys
import yaml

def now_iso():
    return datetime.datetime.now(
        datetime.timezone(datetime.timedelta(hours=7))
    ).isoformat()

def extract_members(dump_data):
    """Extract all unique members across all group arrays."""
    seen = {}
    for group in dump_data.get("groups", []):
        for key in ("members", "pending_members", "requesting_members", "banned_members"):
            arr = group.get(key) or []
            for m in arr:
                uuid = m.get("uuid")
                if uuid and uuid not in seen:
                    seen[uuid] = m
    return list(seen.values())

def clean_value(v):
    """Normalize None→empty string for JSON round-trip."""
    if isinstance(v, dict):
        return {kk: clean_value(vv) for kk, vv in v.items()}
    elif isinstance(v, list):
        return [clean_value(x) for x in v]
    elif v is None:
        return ""
    return v

def read_existing_profiles(trustgraph_path):
    """Read existing trustgraph.yaml, return dict of bare-uuid → profile."""
    if not os.path.exists(trustgraph_path):
        return {}

    with open(trustgraph_path) as f:
        data = yaml.safe_load(f)

    if data is None:
        return {}

    profiles = {}
    for k, v in (data.get("profiles") or {}).items():
        bare_uuid = k.replace("uuid:", "", 1) if k.startswith("uuid:") else k
        profiles[bare_uuid] = clean_value(v)
    return profiles

def build_profiles(existing, members, now_ts):
    """Merge members into existing profiles. Returns dict of bare-uuid → profile."""
    result = dict(existing)

    for member in members:
        uuid = member["uuid"]
        is_new = uuid not in result

        if is_new:
            result[uuid] = {
                "name": member.get("name") or "",
                "first_seen": now_ts,
                "last_seen": now_ts,
                "trust": 0,
                "nature": None,
                "preferences": None,
                "expertise": [],
                "history": [],
                "contact": member.get("number") or "",
            }
            print(f"  + new profile  {uuid}", file=sys.stderr)
        else:
            p = result[uuid]
            p["last_seen"] = now_ts
            if not p.get("name") and member.get("name"):
                p["name"] = member["name"]
            if not p.get("contact") and member.get("number"):
                p["contact"] = member["number"]
            name_str = f".name={p['name']}" if p.get("name") else ""
            print(f"  ~ existing    {uuid}{name_str}", file=sys.stderr)

    return result

def write_yaml(profiles, output_path):
    """Write profiles dict as YAML with header."""
    data = {"profiles": {"uuid:" + k: v for k, v in profiles.items()}}

    def str_representer(dumper, data):
        s = str(data)
        if "\n" in s:
            return dumper.represent_scalar("tag:yaml.org,2002:str", s, style="|")
        return dumper.represent_scalar("tag:yaml.org,2002:str", s)

    yaml.add_representer(str, str_representer)

    lines = [
        "# trustgraph.yaml — Lumina social memory (L3)",
        "# DO NOT EDIT BY HAND — managed by trustgraph-build.sh",
        f"# Updated:{now_iso()}",
        "",
        yaml.dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True),
    ]
    content = "\n".join(lines)

    with open(output_path, "w") as f:
        f.write(content)

def main():
    parser = argparse.ArgumentParser(description="Build trustgraph.yaml from Signal identity dump")
    parser.add_argument("workspace", help="OpenClaw workspace path")
    parser.add_argument("--dump", dest="dump_path", help="Path to signal identity dump JSON")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_dump = os.path.join(script_dir, "signal-identity-dumps", "current.json")
    dump_path = args.dump_path or default_dump

    if not os.path.exists(dump_path):
        print(f"❌ dump not found: {dump_path}", file=sys.stderr)
        sys.exit(1)

    trustgraph_path = os.path.join(args.workspace, "trustgraph.yaml")
    backup_path = trustgraph_path + ".bak"

    print(f"📋 Building trust graph from: {dump_path}", file=sys.stderr)
    print(f"   workspace: {args.workspace}", file=sys.stderr)
    if args.dry_run:
        print("   (--dry-run: no files will change)", file=sys.stderr)
    print("", file=sys.stderr)

    with open(dump_path) as f:
        dump_data = json.load(f)

    members = extract_members(dump_data)
    print(f"🔍 found {len(members)} unique member(s) across all groups", file=sys.stderr)
    print("", file=sys.stderr)

    existing = read_existing_profiles(trustgraph_path)
    now_ts = now_iso()
    profiles = build_profiles(existing, members, now_ts)

    total = len(profiles)
    new_count = sum(1 for uuid, p in profiles.items() if uuid not in existing)
    updated_count = len(profiles) - new_count

    print("", file=sys.stderr)
    print(f"  📝 {total} total profiles", file=sys.stderr)
    print(f"  📝 {new_count} new, {updated_count} updated", file=sys.stderr)

    if args.dry_run:
        print("", file=sys.stderr)
        print(f"  [dry-run] would write updated {trustgraph_path}", file=sys.stderr)
        return

    if os.path.exists(trustgraph_path):
        import shutil
        shutil.copy(trustgraph_path, backup_path)
        print("", file=sys.stderr)
        print(f"  💾 backed up existing to {backup_path}", file=sys.stderr)

    write_yaml(profiles, trustgraph_path)
    print("", file=sys.stderr)
    print(f"  ✅ wrote {trustgraph_path}", file=sys.stderr)

if __name__ == "__main__":
    main()