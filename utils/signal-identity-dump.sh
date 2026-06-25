#!/bin/bash
# signal-identity-dump.sh — emit a JSON snapshot of:
#   .self     full local-account identity (number, uuid, env, profile)
#   .contacts every known contact with all metadata signal-cli exposes
#   .groups   every group you're a member of, plus full member lists
#
# Usage:
#   ./signal-identity-dump.sh                   # auto-detect account from accounts.json
#   ./signal-identity-dump.sh +6283167492405    # explicit account
#
# Notes:
#   - signal-cli has no built-in 'whoami' subcommand. The local account's UUID
#     is read from ~/.local/share/signal-cli/data/accounts.json (the only place
#     it's exposed at rest).
#   - Self profile fields (name/about/avatar) are pulled from the contacts list
#     entry whose UUID matches self, since signal-cli stores own profile there.
#   - Group membership / contact metadata uses --output=json (always detailed).

set -euo pipefail

ACCOUNTS_FILE="${SIGNAL_CLI_DATA:-$HOME/.local/share/signal-cli/data}/accounts.json"
SIGNAL_CLI="${SIGNAL_CLI:-signal-cli}"

if [[ ! -r "$ACCOUNTS_FILE" ]]; then
  echo "error: cannot read $ACCOUNTS_FILE" >&2
  echo "  set SIGNAL_CLI_DATA to override the data dir." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

# Resolve target account: arg > first registered.
ACCOUNT_NUMBER="${1:-}"
if [[ -z "$ACCOUNT_NUMBER" ]]; then
  ACCOUNT_NUMBER="$(jq -r '.accounts[0].number // empty' "$ACCOUNTS_FILE")"
  if [[ -z "$ACCOUNT_NUMBER" ]]; then
    echo "error: no accounts found in $ACCOUNTS_FILE" >&2
    exit 1
  fi
fi

# Self identity from accounts.json.
SELF_BASE="$(jq --arg num "$ACCOUNT_NUMBER" \
  '.accounts[] | select(.number == $num)' "$ACCOUNTS_FILE")"
if [[ -z "$SELF_BASE" || "$SELF_BASE" == "null" ]]; then
  echo "error: account $ACCOUNT_NUMBER not registered in $ACCOUNTS_FILE" >&2
  exit 1
fi
SELF_UUID="$(echo "$SELF_BASE" | jq -r '.uuid')"

# Strip signal-cli's stderr/log noise; keep only the JSON line.
clean_signal_json() {
  grep -vE '^(INFO|DEBUG|WARN|ERROR)\s|^[0-9-]+T[0-9:.+-]+\s'
}

CONTACTS_JSON="$("$SIGNAL_CLI" -a "$ACCOUNT_NUMBER" --output=json listContacts 2>/dev/null \
  | clean_signal_json | tail -1)"
GROUPS_JSON="$("$SIGNAL_CLI" -a "$ACCOUNT_NUMBER" --output=json listGroups 2>/dev/null \
  | clean_signal_json | tail -1)"

[[ -z "$CONTACTS_JSON" ]] && CONTACTS_JSON="[]"
[[ -z "$GROUPS_JSON" ]]   && GROUPS_JSON="[]"

# Pull self's contact record (if signal-cli stored own profile there) to enrich.
SELF_PROFILE="$(echo "$CONTACTS_JSON" \
  | jq --arg uuid "$SELF_UUID" '[.[] | select(.uuid == $uuid)] | first // null')"

# Compose final output.
jq -n \
  --argjson self_base    "$SELF_BASE" \
  --argjson self_profile "$SELF_PROFILE" \
  --argjson contacts     "$CONTACTS_JSON" \
  --argjson groups       "$GROUPS_JSON" \
  '{
    self: ($self_base + (
      if $self_profile == null then {}
      else { contact_record: $self_profile }
      end
    )),
    contacts: $contacts,
    contacts_count: ($contacts | length),
    groups: ($groups | map({
      id, name, description,
      active: .isMember // .active,
      blocked: .isBlocked // .blocked,
      message_expiration_seconds: .messageExpirationTime,
      group_invite_link: .groupInviteLink,
      member_count: (.members | length),
      members: .members,
      pending_members: (.pendingMembers // []),
      requesting_members: (.requestingMembers // []),
      banned_members: (.bannedMembers // [])
    })),
    groups_count: ($groups | length),
    generated_at: (now | todateiso8601)
  }'
