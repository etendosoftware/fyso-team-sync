#!/bin/bash
# Fyso Team Sync — Usage tracking hook v2.0
# Reads hook data from stdin (JSON) and sends to Fyso API
# Supports: session_start, session_end, agent_dispatch, subagent_start, subagent_stop

CONFIG="$HOME/.fyso/config.json"
[ ! -f "$CONFIG" ] && exit 0

# Read stdin to temp file (avoids quoting issues)
TMPFILE=$(mktemp)
cat > "$TMPFILE" 2>/dev/null || true

EVENT_TYPE="${1:-session}"

# Debug: save raw stdin for inspection
if [ -f "$HOME/.fyso/debug" ]; then
  echo "=== $(date -u) === EVENT=$EVENT_TYPE ===" >> "$HOME/.fyso/hook-debug.log"
  cp "$TMPFILE" "$HOME/.fyso/last-hook-stdin.json" 2>/dev/null
  echo "TMPFILE=$TMPFILE size=$(wc -c < "$TMPFILE")" >> "$HOME/.fyso/hook-debug.log"
fi

# Single python call: read config + parse stdin + build payload + send
export TMPFILE EVENT_TYPE
python3 << 'PYEOF'
import json, re, datetime, os, sys, getpass, hashlib
try:
    import urllib.request
except:
    sys.exit(0)

config_path = os.path.expanduser("~/.fyso/config.json")
try:
    with open(config_path) as f:
        cfg = json.load(f)
except:
    sys.exit(0)

token = cfg.get("token", "")
tenant = cfg.get("tenant_id", "")
api_url = cfg.get("api_url", "https://api.fyso.dev")
user_email = cfg.get("user_email", "")

if not token or not tenant:
    sys.exit(0)

# Read stdin JSON from temp file (once)
tmpfile = os.environ.get("TMPFILE", "")
hook = {}
if tmpfile and os.path.exists(tmpfile):
    try:
        with open(tmpfile) as f:
            content = f.read().strip()
        if content:
            hook = json.loads(content)
    except:
        pass
    finally:
        try:
            os.unlink(tmpfile)
        except:
            pass

# Team info from local .fyso/team.json (per project directory)
team_name = ""
hook_cwd = hook.get("cwd", os.getcwd())
try:
    team_path = os.path.join(hook_cwd, ".fyso", "team.json")
    if os.path.exists(team_path):
        with open(team_path) as tf:
            team_name = json.load(tf).get("team_name", "")
except:
    pass

event_type = os.environ.get("EVENT_TYPE", "session")

# Session ID
session_id = hook.get("session_id", "")
if not session_id:
    key = f"{os.getppid()}-{datetime.date.today().isoformat()}"
    session_id = hashlib.md5(key.encode()).hexdigest()[:12]

# Tool info
tool_name = hook.get("tool_name", "")
tool_input = hook.get("tool_input", {}) or {}
tool_response = hook.get("tool_response", {}) or {}

# Agent name from input
agent = ""
if isinstance(tool_input, dict):
    agent = tool_input.get("subagent_type", "") or tool_input.get("name", "") or ""

# Action detail from input description
detail = ""
if isinstance(tool_input, dict):
    detail = tool_input.get("description", "") or tool_input.get("prompt", "")
    if isinstance(detail, str) and len(detail) > 200:
        detail = detail[:200] + "..."
if event_type == "session_start":
    detail = "session start"
elif event_type == "session_end":
    # Extract a summary from the last assistant message in the transcript
    transcript_path = hook.get("transcript_path", "")
    summary = ""
    if transcript_path and os.path.exists(transcript_path):
        try:
            last_text = ""
            tools_used = []
            with open(transcript_path) as tf:
                for line in tf:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        msg = entry.get("message", {})
                        if not isinstance(msg, dict):
                            continue
                        content = msg.get("content", [])
                        if isinstance(content, list):
                            for c in content:
                                if isinstance(c, dict):
                                    if c.get("type") == "tool_use":
                                        name = c.get("name", "")
                                        if name and name not in tools_used[-5:]:
                                            tools_used.append(name)
                                    if c.get("type") == "text" and msg.get("role") == "assistant":
                                        t = c.get("text", "").strip()
                                        if t and len(t) > 10:
                                            last_text = t
                    except:
                        continue
            # Build summary: last meaningful text + recent tools
            if last_text:
                # Take first line, truncate
                first_line = last_text.split("\n")[0][:120]
                summary = first_line
            elif tools_used:
                summary = "Used: " + ", ".join(tools_used[-5:])
        except:
            pass
    detail = summary if summary else "session end"

# Token breakdown: extract individual token types
input_tokens = 0
output_tokens = 0
cache_creation_tokens = 0
cache_read_tokens = 0
model = ""
message_id = ""

if isinstance(tool_response, dict):
    usage = tool_response.get("usage", {})
    if isinstance(usage, dict):
        input_tokens = usage.get("input_tokens", 0) or 0
        output_tokens = usage.get("output_tokens", 0) or 0
        cache_creation_tokens = usage.get("cache_creation_input_tokens", 0) or 0
        cache_read_tokens = usage.get("cache_read_input_tokens", 0) or 0
    # Fallback to totalTokens if no breakdown
    if not (input_tokens or output_tokens):
        total = tool_response.get("totalTokens", 0) or 0
        if total:
            output_tokens = total  # conservative: attribute to output

tokens = input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens

# Message ID for deduplication
if isinstance(tool_response, dict):
    message_id = tool_response.get("id", "") or tool_response.get("requestId", "") or ""
if not message_id and isinstance(hook, dict):
    message_id = hook.get("requestId", "") or ""

# Model extraction from transcript (last entry with model info)
transcript_path = hook.get("transcript_path", "")
if transcript_path and os.path.exists(transcript_path):
    try:
        with open(transcript_path) as tf:
            for line in tf:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    msg = entry.get("message", {})
                    if isinstance(msg, dict):
                        m = msg.get("model", "")
                        if m:
                            model = m
                except:
                    continue
    except:
        pass

# For session_end: sum ALL tokens from transcript
session_tokens = 0
session_input = 0
session_output = 0
session_cache_creation = 0
session_cache_read = 0
if event_type == "session_end":
    if transcript_path and os.path.exists(transcript_path):
        try:
            with open(transcript_path) as tf:
                for line in tf:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        msg = entry.get("message", {})
                        if isinstance(msg, dict):
                            u = msg.get("usage", {})
                            if isinstance(u, dict):
                                session_input += (u.get("input_tokens", 0) or 0)
                                session_output += (u.get("output_tokens", 0) or 0)
                                session_cache_creation += (u.get("cache_creation_input_tokens", 0) or 0)
                                session_cache_read += (u.get("cache_read_input_tokens", 0) or 0)
                    except:
                        continue
            session_tokens = session_input + session_output + session_cache_creation + session_cache_read
        except:
            pass
    tokens = 0
    input_tokens = 0
    output_tokens = 0
    cache_creation_tokens = 0
    cache_read_tokens = 0

# Cost calculation (per 1M tokens)
PRICING = {
    "opus":   {"input": 15,   "output": 75,  "cache_write": 18.75, "cache_read": 1.5},
    "sonnet": {"input": 3,    "output": 15,  "cache_write": 3.75,  "cache_read": 0.3},
    "haiku":  {"input": 0.8,  "output": 4,   "cache_write": 1.0,   "cache_read": 0.08},
}
model_family = "opus" if "opus" in model else "sonnet" if "sonnet" in model else "haiku" if "haiku" in model else ""

def calc_cost(inp, out, cw, cr, family):
    p = PRICING.get(family)
    if not p:
        return 0
    return (inp / 1e6) * p["input"] + (out / 1e6) * p["output"] + (cw / 1e6) * p["cache_write"] + (cr / 1e6) * p["cache_read"]

cost_usd = calc_cost(input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, model_family)
session_cost_usd = calc_cost(session_input, session_output, session_cache_creation, session_cache_read, model_family) if event_type == "session_end" else 0

# User
user = user_email or getpass.getuser()

# Build payload
data = {
    "event": event_type,
    "tool": tool_name or None,
    "agent": agent or None,
    "detail": detail or None,
    "team_name": team_name or None,
    "user": user or None,
    "session_id": session_id or None,
    "model": model or None,
    "model_family": model_family or None,
    "message_id": message_id or None,
    "tokens": tokens if tokens > 0 else None,
    "input_tokens": input_tokens if input_tokens > 0 else None,
    "output_tokens": output_tokens if output_tokens > 0 else None,
    "cache_creation_tokens": cache_creation_tokens if cache_creation_tokens > 0 else None,
    "cache_read_tokens": cache_read_tokens if cache_read_tokens > 0 else None,
    "session_tokens": session_tokens if session_tokens > 0 else None,
    "session_input_tokens": session_input if session_input > 0 else None,
    "session_output_tokens": session_output if session_output > 0 else None,
    "session_cache_creation_tokens": session_cache_creation if session_cache_creation > 0 else None,
    "session_cache_read_tokens": session_cache_read if session_cache_read > 0 else None,
    "cost_usd": round(cost_usd, 6) if cost_usd > 0 else None,
    "session_cost_usd": round(session_cost_usd, 6) if session_cost_usd > 0 else None,
    "cwd": hook.get("cwd", os.getcwd()) or None,
    "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
}
data = {k: v for k, v in data.items() if v is not None}
payload = json.dumps(data).encode()

# Debug: log payload
debug_path = os.path.expanduser("~/.fyso/debug")
if os.path.exists(debug_path):
    log_path = os.path.expanduser("~/.fyso/hook-debug.log")
    with open(log_path, "a") as dl:
        dl.write(f"PAYLOAD: {payload.decode()}\n")

# Send
try:
    req = urllib.request.Request(
        f"{api_url}/api/entities/tracking/records",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "X-Tenant-ID": tenant,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=5)
    resp_body = resp.read().decode()
    if os.path.exists(debug_path):
        with open(log_path, "a") as dl:
            dl.write(f"RESPONSE: {resp.status} {resp_body[:200]}\n\n")
except Exception as e:
    if os.path.exists(debug_path):
        log_path = os.path.expanduser("~/.fyso/hook-debug.log")
        with open(log_path, "a") as dl:
            dl.write(f"ERROR: {e}\n\n")
PYEOF

# Cleanup
rm -f "$TMPFILE" 2>/dev/null
exit 0
