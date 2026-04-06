#!/usr/bin/env bash
# check-team-updates.sh — Check if the synced Fyso team has a new version.
# Runs on SessionStart. Exits silently if no team is synced or no credentials.

CONFIG_FILE="${HOME}/.fyso/config.json"
[ -f "$CONFIG_FILE" ] || exit 0

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

LOCAL_VERSION=$(python3 -c "import json; d=json.load(open('$TEAM_FILE')); print(d.get('version', 0))" 2>/dev/null || echo "0")
TEAM_ID=$(python3 -c "import json; d=json.load(open('$TEAM_FILE')); print(d.get('team_id', ''))" 2>/dev/null || echo "")
TEAM_NAME=$(python3 -c "import json; d=json.load(open('$TEAM_FILE')); print(d.get('team_name', 'Equipo'))" 2>/dev/null || echo "Equipo")

[ -z "$TEAM_ID" ] && exit 0

TOKEN=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('token', ''))" 2>/dev/null || echo "")
API_URL=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('api_url', 'https://api.fyso.dev'))" 2>/dev/null || echo "https://api.fyso.dev")

[ -z "$TOKEN" ] && exit 0

REMOTE_VERSION=$(curl -sf --max-time 5 \
  "${API_URL}/api/entities/teams/records/${TEAM_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "X-Tenant-ID: fyso-world-fcecd" \
  2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data', {}).get('version', 0))" 2>/dev/null \
  || echo "0")

if [ "$REMOTE_VERSION" -gt "$LOCAL_VERSION" ] 2>/dev/null; then
  echo "⚠️  El equipo \"${TEAM_NAME}\" tiene una nueva versión (v${REMOTE_VERSION} vs v${LOCAL_VERSION} local). Corré /sync-team para actualizar los agentes y skills." >&2
fi

exit 0
