---
name: sync-team
description: Sync a Fyso agent team to local .claude/agents/ directory. Downloads agent definitions and creates .md files for Claude Code to use as subagents.
user-invocable: true
---

# Sync Fyso Team Agents

Follow these steps exactly to sync a Fyso team's agents and skills into the
local `.claude/agents/` and `.claude/skills/` directories. This skill runs
inside Claude Code, and once connected, reads the team catalog through the
`fyso` MCP server (tools `listar_equipos` / `obtener_equipo`) — never via
`curl` against fyso directly, and never with a URL or token typed into a
shell command.

## Config structure

This plugin uses two config files:

- `~/.fyso/config.json` — **global** (shared across all projects). Also read
  by the hooks in `hooks/dispatcher.js` for telemetry and the team-version
  check, so its shape is a shared contract: **exactly two keys**, `token`
  and `api_url`. Never add `tenant_id` (the tenant travels inside the token;
  the server resolves it) or `user_email` (the server resolves identity from
  the token too).
- `.fyso/team.json` — **local** (team info, per project directory).

## Step 0 — Check Etendo dev environment

Before syncing, verify the Etendo development plugins are installed. Run this command:

```bash
python3 -c "
import json, sys
try:
    with open('${HOME}/.claude/settings.json') as f:
        d = json.load(f)
except:
    d = {}
plugins = d.get('enabledPlugins', {})
markets = d.get('extraKnownMarketplaces', {})
missing_market = 'etendo-marketplace' not in markets
missing_da = 'dev-assistant@etendo-marketplace' not in plugins
missing_wm = 'etendo-workflow-manager@etendo-marketplace' not in plugins
print('marketplace_missing=' + str(missing_market))
print('dev_assistant_missing=' + str(missing_da))
print('workflow_manager_missing=' + str(missing_wm))
"
```

Evaluate the output:

**If all three print `False`**: Etendo environment is ready. Continue to Step 1.

**If any print `True`**: Inform the user which plugins are missing and show them the exact commands to run in Claude Code (these are slash commands, not shell commands — the user must type them directly in the Claude Code prompt):

| Missing | Command to run in Claude Code |
|---------|-------------------------------|
| `marketplace_missing=True` | `/plugin marketplace add etendosoftware/etendo_claude_marketplace` |
| `dev_assistant_missing=True` | `/plugin install dev-assistant@etendo_claude_marketplace` |
| `workflow_manager_missing=True` | `/plugin install etendo-workflow-manager@etendo_claude_marketplace` |

Tell the user:
> Los plugins de Etendo no están instalados. Para tener el entorno completo de desarrollo, ejecutá los comandos de arriba directamente en el prompt de Claude Code (no en la terminal). Después de instalarlos, reiniciá esta sesión y corré `/sync-team` de nuevo.
>
> Podés seguir el proceso de sync ahora si solo necesitás los agentes de Fyso, o pausar para instalar primero los plugins de Etendo.

Ask: **"¿Querés continuar con el sync o pausar para instalar los plugins de Etendo primero?"** Wait for their answer before continuing.

If they want to continue anyway, proceed to Step 1. If they want to pause, stop here and remind them to run the install commands above.

## Step 1 — Check whether this plugin itself is outdated

Plugin auto-update exists in Claude Code but is opt-in, so some users will be
sitting on an old build without knowing it. This check is best-effort and
never blocks the rest of the flow — if it can't reach the network, say
nothing and move on.

```bash
python3 -c "
import json, os, urllib.request

plugin_root = os.environ.get('CLAUDE_PLUGIN_ROOT', os.getcwd())
local_version = ''
try:
    with open(os.path.join(plugin_root, '.claude-plugin', 'plugin.json')) as f:
        local_version = json.load(f).get('version', '')
except Exception:
    pass

remote_version = ''
try:
    url = 'https://raw.githubusercontent.com/etendosoftware/fyso-team-sync/main/.claude-plugin/plugin.json'
    with urllib.request.urlopen(url, timeout=3) as resp:
        remote_version = json.load(resp).get('version', '')
except Exception:
    pass

def parts(v):
    try:
        return tuple(int(x) for x in v.split('.'))
    except Exception:
        return None

lp, rp = parts(local_version), parts(remote_version)
outdated = bool(lp and rp and rp > lp)

print('local_version=' + local_version)
print('remote_version=' + remote_version)
print('outdated=' + str(outdated))
"
```

If `outdated=True`, tell the user before continuing:

> Estás corriendo fyso-team-sync v{local_version}, pero la última versión publicada es v{remote_version}. La actualización automática de plugins es opcional, así que puede que la tuya no se haya actualizado sola. Corré `/plugin update fyso-team-sync` (o esperá al próximo reinicio si tenés auto-update activado) cuando puedas.

If the check fails (no network, parse error, missing fields) just continue silently — do not mention it to the user.

## Step 2 — Get the connection info

This skill can be invoked two ways.

### A) Invoked with arguments: `/sync-team <origin> <token>`

The onboarding screen "Conectar mis agentes" in fyso-business gives the user
a copyable block with exactly this form. `<origin>` is the instance's base
URL (e.g. `https://acme.fyso-business.com`) and `<token>` is their personal
token (`fyb_<tenant>_<hex>`). Use these two values directly — they always
take priority over whatever is saved. Continue to Step 3.

### B) Invoked with no arguments

Check whether `~/.fyso/config.json` exists and has both `token` and
`api_url`.

- **If it does**: tell the user you're using the saved connection (mention
  the `api_url` so they know which instance) and skip straight to Step 4 —
  do not touch the config file, do not re-register the MCP server, do not
  ask for confirmation.
- **If it doesn't** (missing, empty, or missing either key): explain where
  to get the command instead of asking for a token directly:

  > Para conectar tus agentes, abrí fyso-business y andá a la pantalla "Conectar mis agentes". Ahí vas a encontrar un comando para copiar con la forma `/sync-team <origin> <token>`. Pegalo acá para conectar.

  Stop here and wait — do not proceed without a valid origin/token pair.

## Step 3 — Save credentials and register the MCP server

Only runs when Step 2 produced a **new** origin/token pair (path A above, or
path B after the user pastes the command). Skip entirely when reusing a
saved config.

### 3a — Save the global config

```bash
mkdir -p ~/.fyso
```

Write `~/.fyso/config.json` with the Write tool, **exactly these two keys**:

```json
{
  "token": "{TOKEN}",
  "api_url": "{ORIGIN}"
}
```

No `tenant_id`, no `user_email`, no `saved_at` — nothing else. If a config
already existed at a different `api_url`, mention that you're replacing the
old connection.

### 3b — Ask the MCP scope

Ask the user where to register the `fyso` MCP server, offering exactly two
options:

- **`user`** (recommended, default if they don't have a preference):
  available in every project.
- **`local`**: only in the current project. If they pick this, tell them
  explicitly: **la telemetría de uso se sigue mandando desde todos los
  proyectos igual** — los hooks del plugin son globales, "local" solo acota
  el acceso MCP, no la telemetría.

**Do not offer `project` scope.** If the user asks for it, decline and
explain why: that scope writes an `.mcp.json` file meant to be committed and
shared with the whole team. A personal token in there ends up in git
history, and revoking the token later doesn't remove it from history —
that's a credential leak, not a style choice.

### 3c — Register it

Check if a `fyso` MCP server is already registered:

```bash
claude mcp list
```

If one is already there, remove it first so the new token replaces the old
one cleanly:

```bash
claude mcp remove fyso
```

Then add it with the chosen scope:

```bash
claude mcp add --transport http fyso {ORIGIN}/api/mcp --header "Authorization: Bearer {TOKEN}" --scope {SCOPE}
```

Report the command's outcome to the user.

## Step 4 — Confirm the MCP tools are reachable

Try calling the `listar_equipos` tool (see Step 5). If it isn't available in
this session yet — the connection was just registered in Step 3 and hasn't
been picked up — tell the user:

> Registré la conexión MCP, pero esta sesión todavía no la tiene activa. Reconectá con `/mcp` (o abrí una sesión nueva) y volvé a correr `/sync-team`.

and stop here. This is expected the very first time; a saved config that was
already in use (Step 2 path B, existing config) should not hit this.

## Step 5 — List teams

Call the `listar_equipos` tool (no parameters). It returns the teams visible
to this token: `id`, `nombre`, `slug`, `descripcion`, `version`,
`departamentos_ids`.

If the list is empty, tell the user there are no teams visible for their
token and stop.

Present the teams in a numbered list (name + slug). Ask the user to pick one
by number, name, or slug. Wait for their response before continuing.

## Step 6 — Fetch the selected team

Call the `obtener_equipo` tool with `equipo_id` set to the selected team's
`id`. It returns `{ equipo, agentes, skills, changelog }`:

- `agentes` — in composition order, each with `nombre`, `nombre_visible`,
  `rol`, `soul`, `system_prompt`, `avatar`, `estado`.
- `skills` — each with `name`, `description`, `content` (same shape as
  before).
- `changelog` — version history entries for the team.

**If the tool responds `not_found`**: treat this exactly the same whether
the team doesn't exist or is out of scope for this token — the tool
deliberately doesn't distinguish the two, so a mismatched team can't be
confirmed to exist. Tell the user:

> No encontré ese equipo.

Never say "no tenés permiso" or anything that confirms the team's existence.
Offer to go back to Step 5's list.

## Step 7 — Save local team info and surface what changed

Before overwriting it, check if `.fyso/team.json` already exists in the
current working directory and read its `version` (this is a resync).

```bash
mkdir -p .fyso
```

Write `.fyso/team.json`:

```json
{
  "team_id": "{equipo.id}",
  "team_name": "{equipo.nombre}",
  "version": {equipo.version, or 0 if absent/null},
  "synced_at": "{ISO_TIMESTAMP}"
}
```

If this was a resync and `changelog` has entries newer than the previous
local `version`, show them to the user as "novedades desde tu última
sincronización" before moving on. If there was no previous `team.json`, or
the changelog has nothing newer, skip this.

## Step 8 — Clean existing agent files

Before creating new files, remove any existing agent files that will be
overwritten. For each agent from `agentes`, check if
`.claude/agents/{nombre}.md` already exists and delete it:

```bash
rm -f .claude/agents/{nombre}.md
```

This ensures a clean sync without stale data from previous runs.

## Step 9 — Create agent files

Ensure the directory exists:

```bash
mkdir -p .claude/agents
```

For each agent in `agentes`, create `.claude/agents/{nombre}.md` with the
Write tool, in this exact format:

```markdown
---
name: {nombre}
description: {rol} -- {nombre_visible}. {first_line_of_soul}
tools: Read, Write, Edit, Bash, Grep, Glob
color: {color}
---

# {nombre_visible}

**Role:** {rol}

## Soul
{soul}

## System Prompt
{system_prompt}
```

IMPORTANT: Include the FULL content of `soul` and `system_prompt`. Do NOT
truncate, summarize, or abbreviate them — these are the agent's complete
instructions.

Map `color` from `rol` using these rules (case-insensitive, partial match —
e.g. "Senior Developer" matches "developer"):

| Role contains | Color  |
|---------------|--------|
| developer     | green  |
| qa or tester  | yellow |
| reviewer      | purple |
| coordinator   | blue   |
| writer        | cyan   |
| security      | red    |
| triage        | orange |
| (anything else) | gray |

For `first_line_of_soul`: the first non-empty line of `soul`, trimmed. If
`soul` is empty, use `nombre_visible` instead.

`avatar` and `estado` are returned by the tool but not used in the generated
file — they're informational metadata, not part of the subagent spec.

## Step 10 — Create skill files

If `skills` is empty, skip to Step 11 and note that no skills were found.

Ensure the directory exists:

```bash
mkdir -p .claude/skills
```

For each skill, delete any existing file with the same name and create a
new one at `.claude/skills/{name}.md` with the Write tool:

```markdown
---
name: {name}
description: {description}
---

{content}
```

If `description` is empty, keep the frontmatter key with an empty string.

IMPORTANT: Include the FULL `content` field exactly as received. Do NOT
truncate, summarize, or modify it.

## Step 11 — Report results

Print a summary covering:

- Whether a plugin-update notice was shown in Step 1.
- Whether this run saved new global credentials / registered the MCP server,
  or reused an existing saved connection.
- The MCP scope chosen (and, if `local`, the reminder that telemetry still
  goes out from every project).
- How many agent files were created, with their full paths.
- How many skill files were created, with their full paths (or "no skills
  found" if none).
- That team info was saved to `.fyso/team.json`, including the current
  version, and any changelog news surfaced in Step 7.
- A reminder that the user can now use these agents as subagents via the
  Task tool or by referencing them.
- A note that at the start of each future session, Claude Code will
  automatically check if the team has a new version and notify the user to
  re-sync if needed.

If no agents were found for the selected team, inform the user and suggest
they check the team configuration in fyso-business.
