# fyso-team-sync — Domain Glossary

## Terms

### Hook
A shell command registered in `hooks/hooks.json` that Claude Code executes automatically on lifecycle events (SessionStart, Stop, UserPromptSubmit, etc.). On macOS/Linux hooks run via `sh -c`; on Windows native via Git Bash or PowerShell fallback.

### Shell Form
Hook execution mode where `command` is a string passed to the system shell. On Windows this is Git Bash (not guaranteed) or PowerShell. Current hooks use this form with `.sh` scripts — incompatible with Windows native without Git Bash.

### Exec Form
Hook execution mode where `command` + `args` bypass the shell entirely and spawn the executable directly. Cross-platform guaranteed. Chosen approach for the Windows-compatible dispatcher.

### Tracking Event
A JSON payload POSTed to `{api_url}/api/entities/tracking/records` representing a lifecycle moment: `session_start`, `session_update`, `agent_dispatch`, `subagent_start`, `subagent_stop`, `usage_limit_hit`, `stop_failure`, `heartbeat`.

### Dispatcher
The new Node.js entry point (`hooks/dispatcher.js`) that replaces `.sh` invocations in `hooks.json`. On Unix: delegates to `bash tracking.sh` unchanged. On Windows: runs tracking logic inline in JavaScript.

### Heartbeat
A background process launched at SessionStart that POSTs a `heartbeat` tracking event every 5 minutes with session activity summary and token counts. On Unix: implemented as a bash loop via `nohup`. On Windows: implemented as a detached Node.js child process.

### Session Flag
A temp file at `os.tmpdir()/fyso-limit-hit-{session_id}` used to deduplicate `usage_limit_hit` events within a single session. Intentionally ephemeral — cleared on system reboot. Mirrors Unix `/tmp/fyso-limit-hit-{session_id}` semantics exactly.

### Global Dedup Flag
A persistent file at `~/.fyso/last-limit-hit` used to suppress duplicate `usage_limit_hit` reports across sessions within a 5-hour window. Lives in `~/.fyso/` on all platforms.
