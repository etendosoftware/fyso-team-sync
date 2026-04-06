#!/usr/bin/env bash
# check-team-updates.sh — Asks Claude to verify team version via Fyso MCP.
# Runs once per session on UserPromptSubmit.
# Outputs an instruction string that Claude Code injects as context before
# processing the user's message — Claude then checks the version with MCP.

# Run only once per Claude Code session (PPID = PID of the Claude process)
FLAG_FILE="/tmp/fyso-version-check-${PPID}"
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

TEAM_ID=$(python3 -c "import json; print(json.load(open('$TEAM_FILE')).get('team_id', ''))" 2>/dev/null || echo "")
[ -z "$TEAM_ID" ] && exit 0

LOCAL_VERSION=$(python3 -c "import json; print(json.load(open('$TEAM_FILE')).get('version', 0))" 2>/dev/null || echo "0")
TEAM_NAME=$(python3 -c "import json; print(json.load(open('$TEAM_FILE')).get('team_name', 'el equipo'))" 2>/dev/null || echo "el equipo")

# Output an instruction for Claude to check the version via MCP.
# Claude Code injects this stdout into the conversation context before
# processing the user's message.
echo "[fyso-team-sync] Este proyecto tiene un equipo Fyso sincronizado: \"${TEAM_NAME}\" (team_id: ${TEAM_ID}, versión local: v${LOCAL_VERSION}). Antes de responder al usuario, consultá silenciosamente con Fyso MCP (fyso_data → get_record en la entidad 'teams', id: ${TEAM_ID}) si hay una versión más nueva. Si la versión remota es mayor a v${LOCAL_VERSION}, informá al usuario en una línea y sugerí que corra /sync-team. Si es la misma versión o no podés consultarlo, no menciones nada."

exit 0
