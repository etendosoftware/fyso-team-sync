#!/usr/bin/env bash
# check-team-updates.sh — Checks if the synced Fyso team has a newer version.
# Runs once per session on UserPromptSubmit.
# Outputs a notification to Claude if a newer version is available in the API.

CONFIG="$HOME/.fyso/config.json"
[ ! -f "$CONFIG" ] && exit 0

# Read session_id from stdin (Claude Code sends JSON payload via stdin)
TMPFILE=$(mktemp)
cat > "$TMPFILE" 2>/dev/null || true
SESSION_ID=$(python3 -c "
import sys, json
try:
    d = json.loads(open('$TMPFILE').read().strip())
    print(d.get('session_id', ''))
except: print('')
" 2>/dev/null)
rm -f "$TMPFILE"

# Run only once per Claude Code session (keyed on session_id)
if [ -n "$SESSION_ID" ]; then
  FLAG_FILE="/tmp/fyso-version-check-${SESSION_ID}"
else
  FLAG_FILE="/tmp/fyso-version-check-${PPID}"
fi
[ -f "$FLAG_FILE" ] && exit 0
touch "$FLAG_FILE"

# Find .fyso/team.json by traversing up from CLAUDE_PROJECT_DIR or PWD
find_team_json() {
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    if [ -f "$dir/.fyso/team.json" ]; then
      echo "$dir/.fyso/team.json"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

TEAM_FILE=$(find_team_json) || exit 0

export TEAM_FILE
python3 << 'PYEOF'
import json, os, sys, urllib.request

config_path = os.path.expanduser("~/.fyso/config.json")
try:
    cfg = json.load(open(config_path))
except Exception:
    sys.exit(0)

token = cfg.get("token", "")
tenant = cfg.get("tenant_id", "")
api_url = cfg.get("api_url", "https://api.fyso.dev")

if not token or not tenant:
    sys.exit(0)

team_file = os.environ.get("TEAM_FILE", "")
try:
    team = json.load(open(team_file))
    team_id = team.get("team_id", "")
    team_name = team.get("team_name", "")
    local_version = int(team.get("version", 0))
except Exception:
    sys.exit(0)

if not team_id:
    sys.exit(0)

try:
    req = urllib.request.Request(
        f"{api_url}/api/entities/teams/records/{team_id}",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Tenant-ID": tenant,
        },
        method="GET",
    )
    resp = urllib.request.urlopen(req, timeout=4)
    data = json.loads(resp.read().decode())
    remote_version = int((data.get("data") or data).get("version", local_version))
except Exception:
    sys.exit(0)

if remote_version > local_version:
    print(
        f"[fyso-team-sync] Hay una nueva versión del equipo \"{team_name}\" disponible "
        f"(local: v{local_version}, remota: v{remote_version}). "
        f"IMPORTANTE: antes de responder al usuario, avisale en una línea que hay una actualización "
        f"disponible y que puede correr /sync-team para actualizar los agentes locales."
    )
PYEOF

exit 0
