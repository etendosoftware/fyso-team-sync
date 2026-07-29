# fyso-team-sync

Claude Code plugin that syncs Fyso agent teams into local `.claude/agents/` files, making them available as subagents.

## Installation

### From GitHub (recommended)

```bash
# Add the marketplace
/plugin marketplace add fyso-dev/fyso-team-sync

# Install the plugin
/plugin install fyso-team-sync@fyso-dev
```

### For a whole team

Add to your project's `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "fyso-team-sync@fyso-dev": true
  }
}
```

### Local development

```bash
claude --plugin-dir /path/to/fyso-team-sync
```

## Usage

Open the "Conectar mis agentes" screen in fyso-business — it gives you a
copyable command with this form:

```
/sync-team <origin> <token>
```

where `<origin>` is your fyso-business instance's base URL and `<token>` is
your personal token (`fyb_<tenant>_<hex>`). Paste it into any Claude Code
session. The skill saves the connection to `~/.fyso/config.json`, registers
the `fyso` MCP server (asking you whether to scope it to `user`, available
in every project, or `local`, just this one — project scope is never
offered, since it would commit a personal token into `.mcp.json`), then
reads your visible teams over that MCP connection and lets you pick one.

Once connected, you can just run `/sync-team` with no arguments in later
sessions or other projects — it reuses the saved connection.

The plugin creates `.claude/agents/` and `.claude/skills/` files in your
current working directory.

## Requirements

- A Fyso Business account with a personal token
- At least one team configured with agents assigned
- Network access to your fyso-business instance (for the MCP connection and
  the usage telemetry the hooks send)

## Generated file format

Each agent file follows the Claude Code agent spec:

```markdown
---
name: agent-slug
description: role -- Display Name. First line of soul.
tools: Read, Write, Edit, Bash, Grep, Glob
color: green
---

# Display Name

**Role:** developer

## Soul
(agent soul text)

## System Prompt
(agent system prompt)
```

Colors are mapped by role: developer=green, qa/tester=yellow, reviewer=purple, coordinator=blue, writer=cyan, security=red, other=gray.
