#!/bin/bash
# Fyso Team Sync — Usage tracking hook v3.0
# Reads hook data from stdin (JSON) and sends to Fyso API
# Supports: session_start, session_end, agent_dispatch, subagent_start, subagent_stop, stop_failure
# v3.0: dual-writes to tracking_daily for real-time per-day aggregates

CONFIG="$HOME/.fyso/config.json"
[ ! -f "$CONFIG" ] && exit 0

# Read stdin to temp file (avoids quoting issues)
TMPFILE=$(mktemp)
cat > "$TMPFILE" 2>/dev/null || true

EVENT_TYPE="${1:-session}"

# Debug: save raw stdin for inspection
if [ -f "$HOME/.fyso/debug" ]; then
  echo "=== $(date -u) === EVENT=$EVENT_TYPE ===" >> "$HOME/.fyso/hook-debug.log"
  cp "$TMPFILE" "$HOME/.fyso/last-hook-stdin-${EVENT_TYPE}.json" 2>/dev/null
  echo "TMPFILE=$TMPFILE size=$(wc -c < "$TMPFILE")" >> "$HOME/.fyso/hook-debug.log"
  echo "STDIN_CONTENT=$(cat "$TMPFILE")" >> "$HOME/.fyso/hook-debug.log"
fi

# Single python call: read config + parse stdin + build payload + send
export TMPFILE EVENT_TYPE
python3 << 'PYEOF'
import json, re, datetime, os, sys, getpass, hashlib, subprocess, fcntl
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

# ── Corporate account detection (matches tracking-aggregator.ts) ──────────────
CORPORATE_DOMAINS = ("@smfconsulting.es", "@etendo.software")

def is_corporate(acct):
    if not acct: return False
    return any(acct.endswith(d) for d in CORPORATE_DOMAINS)

# ── tracking_daily dual-write helper ──────────────────────────────────────────
# Maintains per-day per-user aggregates in real-time so the dashboard can read
# from a pre-aggregated table instead of scanning raw events. Delta logic
# attributes tokens/cost to the claude_account of the current event.
# Fire-and-forget: failures here never block the main tracking POST.
def upsert_tracking_daily(api_url, token, tenant, debug_path,
                          date_str, user_email, event_type, claude_account,
                          model, input_tokens, output_tokens,
                          cache_creation_tokens, cache_read_tokens,
                          cost_usd, is_dispatch, agent_name):
    import urllib.request, urllib.parse
    def _dbg(msg):
        if debug_path and os.path.exists(debug_path):
            try:
                with open(os.path.expanduser("~/.fyso/hook-debug.log"), "a") as _l:
                    _l.write(f"DAILY: {msg}\n")
            except: pass

    is_usage_limit = event_type == "usage_limit_hit"
    is_rate_limit = event_type in ("rate_limit_hit", "overloaded_hit")
    corp = is_corporate(claude_account)

    delta_cost = float(cost_usd or 0)
    delta_in = int(input_tokens or 0)
    delta_out = int(output_tokens or 0)
    delta_cc = int(cache_creation_tokens or 0)
    delta_cr = int(cache_read_tokens or 0)
    delta_total = delta_in + delta_out + delta_cc + delta_cr

    session_inc = 1 if event_type == "session_start" else 0
    personal_session_inc = session_inc if (claude_account and not corp) else 0
    dispatch_inc = 1 if is_dispatch else 0
    usage_limit_inc = 1 if is_usage_limit else 0
    rate_limit_inc = 1 if is_rate_limit else 0

    headers_ = {
        "Authorization": f"Bearer {token}",
        "X-Tenant-ID": tenant,
        "Content-Type": "application/json",
    }
    params = urllib.parse.urlencode({
        "limit": 1,
        "filter.date": date_str,
        "filter.user": user_email,
    })

    # GET existing record for (date, user)
    try:
        get_req = urllib.request.Request(
            f"{api_url}/api/entities/tracking_daily/records?{params}",
            headers=headers_,
        )
        get_resp = urllib.request.urlopen(get_req, timeout=4)
        get_data = json.loads(get_resp.read().decode())
        items = get_data.get("data", {}).get("items", [])
    except Exception as e:
        _dbg(f"GET failed: {e}")
        return

    existing = items[0] if items else None

    if existing:
        # Merge with existing row
        models_set = set(m.strip() for m in (existing.get("models", "") or "").split(",") if m.strip())
        if model: models_set.add(model)

        # Merge accounts_data
        try:
            accts = json.loads(existing.get("accounts_data") or "[]")
        except: accts = []
        if claude_account:
            entry = next((e for e in accts if e.get("account") == claude_account), None)
            if not entry:
                entry = {
                    "account": claude_account,
                    "isPersonal": not corp,
                    "sessions": 0,
                    "inputTokens": 0, "outputTokens": 0,
                    "cacheCreateTokens": 0, "cacheReadTokens": 0,
                    "costUsd": 0,
                }
                accts.append(entry)
            entry["sessions"] = int(entry.get("sessions", 0) or 0) + session_inc
            entry["inputTokens"] = int(entry.get("inputTokens", 0) or 0) + delta_in
            entry["outputTokens"] = int(entry.get("outputTokens", 0) or 0) + delta_out
            entry["cacheCreateTokens"] = int(entry.get("cacheCreateTokens", 0) or 0) + delta_cc
            entry["cacheReadTokens"] = int(entry.get("cacheReadTokens", 0) or 0) + delta_cr
            entry["costUsd"] = float(entry.get("costUsd", 0) or 0) + delta_cost

        # Merge agents_data (only on dispatch)
        try:
            agts = json.loads(existing.get("agents_data") or "[]")
        except: agts = []
        if is_dispatch and agent_name:
            entry = next((e for e in agts if e.get("agent") == agent_name), None)
            if not entry:
                entry = {
                    "agent": agent_name,
                    "dispatches": 0, "tokens": 0, "costUsd": 0,
                    "users": [],
                }
                agts.append(entry)
            entry["dispatches"] = int(entry.get("dispatches", 0) or 0) + 1
            entry["tokens"] = int(entry.get("tokens", 0) or 0) + delta_total
            entry["costUsd"] = float(entry.get("costUsd", 0) or 0) + delta_cost
            users_list = entry.get("users") or []
            if user_email not in users_list:
                users_list.append(user_email)
            entry["users"] = users_list

        new_personal_sessions = int(existing.get("personal_sessions", 0) or 0) + personal_session_inc
        new_data = {
            "session_count": int(existing.get("session_count", 0) or 0) + session_inc,
            "cost_usd": round(float(existing.get("cost_usd", 0) or 0) + delta_cost, 6),
            "input_tokens": int(existing.get("input_tokens", 0) or 0) + delta_in,
            "output_tokens": int(existing.get("output_tokens", 0) or 0) + delta_out,
            "cache_creation_tokens": int(existing.get("cache_creation_tokens", 0) or 0) + delta_cc,
            "cache_read_tokens": int(existing.get("cache_read_tokens", 0) or 0) + delta_cr,
            "total_tokens": int(existing.get("total_tokens", 0) or 0) + delta_total,
            "corporate_cost_usd": round(float(existing.get("corporate_cost_usd", 0) or 0) + (delta_cost if corp else 0), 6),
            "personal_cost_usd": round(float(existing.get("personal_cost_usd", 0) or 0) + (delta_cost if not corp else 0), 6),
            "dispatches": int(existing.get("dispatches", 0) or 0) + dispatch_inc,
            "usage_limit_hits": int(existing.get("usage_limit_hits", 0) or 0) + usage_limit_inc,
            "rate_limit_hits": int(existing.get("rate_limit_hits", 0) or 0) + rate_limit_inc,
            "personal_sessions": new_personal_sessions,
            "used_personal_account": bool(existing.get("used_personal_account")) or new_personal_sessions > 0,
            "models": ",".join(sorted(models_set)),
            "accounts_data": json.dumps(accts) if accts else "",
            "agents_data": json.dumps(agts) if agts else "",
        }

        try:
            put_req = urllib.request.Request(
                f"{api_url}/api/entities/tracking_daily/records/{existing['id']}",
                data=json.dumps(new_data).encode(),
                headers=headers_,
                method="PUT",
            )
            urllib.request.urlopen(put_req, timeout=4)
            _dbg(f"PUT ok: {date_str}/{user_email}")
        except Exception as e:
            _dbg(f"PUT failed: {e}")
    else:
        # Create new row
        accts_init = []
        if claude_account:
            accts_init = [{
                "account": claude_account,
                "isPersonal": not corp,
                "sessions": session_inc,
                "inputTokens": delta_in, "outputTokens": delta_out,
                "cacheCreateTokens": delta_cc, "cacheReadTokens": delta_cr,
                "costUsd": delta_cost,
            }]
        agts_init = []
        if is_dispatch and agent_name:
            agts_init = [{
                "agent": agent_name,
                "dispatches": 1,
                "tokens": delta_total,
                "costUsd": delta_cost,
                "users": [user_email],
            }]

        new_data = {
            "name": f"{date_str}_{user_email}",
            "date": date_str,
            "user": user_email,
            "session_count": session_inc,
            "cost_usd": round(delta_cost, 6),
            "input_tokens": delta_in,
            "output_tokens": delta_out,
            "cache_creation_tokens": delta_cc,
            "cache_read_tokens": delta_cr,
            "total_tokens": delta_total,
            "corporate_cost_usd": round(delta_cost if corp else 0, 6),
            "personal_cost_usd": round(delta_cost if not corp else 0, 6),
            "dispatches": dispatch_inc,
            "usage_limit_hits": usage_limit_inc,
            "rate_limit_hits": rate_limit_inc,
            "personal_sessions": personal_session_inc,
            "used_personal_account": personal_session_inc > 0,
            "models": model or "",
            "accounts_data": json.dumps(accts_init) if accts_init else "",
            "agents_data": json.dumps(agts_init) if agts_init else "",
        }

        try:
            post_req = urllib.request.Request(
                f"{api_url}/api/entities/tracking_daily/records",
                data=json.dumps(new_data).encode(),
                headers=headers_,
                method="POST",
            )
            urllib.request.urlopen(post_req, timeout=4)
            _dbg(f"POST ok: {date_str}/{user_email}")
        except Exception as e:
            _dbg(f"POST failed: {e}")

# Events that don't contribute to tracking_daily (summaries, heartbeats)
# session_update is no longer skipped — deltas are computed via session state file
TRACKING_DAILY_SKIP_EVENTS = {"heartbeat", "session_end"}

# ── Session state helpers (for session_update delta computation) ───────────────
_SESSION_STATE_PATH = os.path.expanduser("~/.fyso/session-state.json")

def _load_sess_state():
    try:
        os.makedirs(os.path.dirname(_SESSION_STATE_PATH), exist_ok=True)
        with open(_SESSION_STATE_PATH, 'a+') as _sf:
            fcntl.flock(_sf, fcntl.LOCK_EX)
            _sf.seek(0)
            content = _sf.read().strip()
            return json.loads(content) if content else {}
    except Exception:
        pass
    return {}

def _save_sess_state(_st):
    try:
        os.makedirs(os.path.dirname(_SESSION_STATE_PATH), exist_ok=True)
        with open(_SESSION_STATE_PATH, 'r+') as _sf:
            fcntl.flock(_sf, fcntl.LOCK_EX)
            _sf.seek(0)
            json.dump(_st, _sf)
            _sf.truncate()
    except Exception:
        pass

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
    # Check if a previous session in this project has an unreported usage limit hit.
    # Runs as background process to avoid the 5s hook timeout.
    _bg_params = {
        "transcript_dir": os.path.dirname(hook.get("transcript_path", "")),
        "session_id": session_id,
        "api_url": api_url,
        "token": token,
        "tenant": tenant,
        "user_email": user_email,
        "cwd": hook.get("cwd", os.getcwd()),
    }
    _bg_script = os.path.join(os.environ.get("CLAUDE_PLUGIN_ROOT", ""), "hooks", "check-prev-limit.py")
    if not os.path.exists(_bg_script):
        _bg_script = os.path.expanduser("~/.fyso/check-prev-limit.py")
    is_debug = os.path.exists(os.path.expanduser("~/.fyso/debug"))
    if is_debug:
        open(os.path.expanduser("~/.fyso/hook-debug.log"), "a").write(f"SESSION_START_LAUNCH: transcript_dir={_bg_params['transcript_dir']} script_exists={os.path.exists(_bg_script)}\n")
    if _bg_params["transcript_dir"] and os.path.exists(_bg_script):
        _bg_params_file = f"/tmp/fyso-bg-check-{session_id}.json"
        try:
            with open(_bg_params_file, "w") as _bf:
                json.dump(_bg_params, _bf)
            subprocess.Popen(
                [sys.executable, "-c",
                 f"import json,os;P=json.load(open('{_bg_params_file}'));exec(open('{_bg_script}').read())"],
                stdout=subprocess.DEVNULL,
                stderr=open(os.path.expanduser("~/.fyso/bg-check-err.log"), "a"),
            )
            if is_debug:
                open(os.path.expanduser("~/.fyso/hook-debug.log"), "a").write("SESSION_START_LAUNCH: Popen OK\n")
        except Exception as _e:
            if is_debug:
                open(os.path.expanduser("~/.fyso/hook-debug.log"), "a").write(f"SESSION_START_LAUNCH: error {_e}\n")

# Token breakdown: extract individual token types from tool_response
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

# Single-pass transcript read: extract model, usage, and summary in one go
transcript_path = hook.get("transcript_path", "")
session_tokens = 0
session_input = 0
session_output = 0
session_cache_creation = 0
session_cache_read = 0
_summary = ""

if transcript_path and os.path.exists(transcript_path):
    # Wait for Claude to finish writing the JSONL before reading it
    if event_type in ("session_update", "session_end"):
        import time
        time.sleep(1)
    debug_log = os.path.expanduser("~/.fyso/debug")
    is_debug = os.path.exists(debug_log)
    _last_text = ""
    _tools_used = []
    _line_count = 0
    _usage_count = 0
    _model_count = 0
    _seen_hashes = {}
    try:
        with open(transcript_path, encoding="utf-8", errors="replace") as tf:
            for raw_line in tf:
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                _line_count += 1
                try:
                    entry = json.loads(raw_line)
                except:
                    continue
                msg = entry.get("message", {})
                if not isinstance(msg, dict):
                    continue

                # Model (keep last seen)
                m = msg.get("model", "")
                if m:
                    model = m
                    _model_count += 1

                # Usage (accumulate for session totals, deduplicated by message.id:requestId)
                u = msg.get("usage", {})
                if isinstance(u, dict) and u:
                    si = u.get("input_tokens", 0) or 0
                    so = u.get("output_tokens", 0) or 0
                    scw = u.get("cache_creation_input_tokens", 0) or 0
                    scr = u.get("cache_read_input_tokens", 0) or 0
                    if si or so or scw or scr:
                        msg_id = msg.get("id", "")
                        req_id = entry.get("requestId", "")
                        if msg_id and req_id:
                            hash_key = f"{msg_id}:{req_id}"
                            if hash_key in _seen_hashes:
                                # Last-wins: subtract previous and replace with updated values
                                prev = _seen_hashes[hash_key]
                                session_input -= prev[0]
                                session_output -= prev[1]
                                session_cache_creation -= prev[2]
                                session_cache_read -= prev[3]
                                _usage_count -= 1
                            _seen_hashes[hash_key] = (si, so, scw, scr)
                        _usage_count += 1
                        session_input += si
                        session_output += so
                        session_cache_creation += scw
                        session_cache_read += scr

                # Summary text (for session_end/session_update detail)
                if event_type in ("session_end", "session_update", "usage_limit_hit"):
                    content = msg.get("content", [])
                    if isinstance(content, list):
                        for c in content:
                            if isinstance(c, dict):
                                if c.get("type") == "tool_use":
                                    name = c.get("name", "")
                                    if name and name not in _tools_used[-5:]:
                                        _tools_used.append(name)
                                if c.get("type") == "text" and msg.get("role") == "assistant":
                                    t = c.get("text", "").strip()
                                    if t and len(t) > 10:
                                        _last_text = t
        session_tokens = session_input + session_output + session_cache_creation + session_cache_read

        if is_debug:
            log_path = os.path.expanduser("~/.fyso/hook-debug.log")
            with open(log_path, "a") as dl:
                dl.write(f"TRANSCRIPT: path={transcript_path} lines={_line_count} usage_entries={_usage_count} model_entries={_model_count} model={model} session_tokens={session_tokens}\n")
    except Exception as e:
        if os.path.exists(os.path.expanduser("~/.fyso/debug")):
            log_path = os.path.expanduser("~/.fyso/hook-debug.log")
            with open(log_path, "a") as dl:
                dl.write(f"TRANSCRIPT_ERROR: {e}\n")

# Fallback: default to opus (Claude Code default model)
if not model:
    model = "claude-opus-4-6"

# Detect usage/rate limit events and override event_type
# 1. Usage limit: Stop hook exposes last_assistant_message with known text
USAGE_LIMIT_KEYWORDS = (
    "usage limit reached", "out of extra usage", "you've reached your usage",
    "usage limit", "you're out of", "limit has been reached", "no remaining",
    "out of claude", "monthly usage", "plan limit", "tokens remaining",
    "run out of", "exhausted your", "quota exceeded", "quota has been",
)

# Handle StopFailure: immediate detection of usage/billing limit via API error
# Fires on the FIRST blocked message — no second prompt needed
if event_type == "stop_failure":
    error_type = hook.get("error_type", "")
    error_message = hook.get("error_message", "") or hook.get("error", "")
    _dbg = os.path.exists(os.path.expanduser("~/.fyso/debug"))
    _dbg_log = os.path.expanduser("~/.fyso/hook-debug.log")
    if _dbg:
        open(_dbg_log, "a").write(f"STOP_FAILURE: error_type={repr(error_type)} error_message={repr(str(error_message)[:200])}\n")
    # Deduplicate: skip if already detected for this session within the last 5 hours
    flag_file = f"/tmp/fyso-limit-hit-{session_id}"
    if session_id and os.path.exists(flag_file):
        try:
            _sess_age_h = (datetime.datetime.now().timestamp() - os.path.getmtime(flag_file)) / 3600
        except:
            _sess_age_h = 0
        if _sess_age_h < 5:
            if _dbg:
                open(_dbg_log, "a").write(f"STOP_FAILURE: flag exists age={_sess_age_h:.1f}h < 5h, skipping\n")
            sys.exit(0)
        if _dbg:
            open(_dbg_log, "a").write(f"STOP_FAILURE: flag expired age={_sess_age_h:.1f}h, re-reporting\n")
    # Cross-session dedup: skip if a limit was already reported within the last 5 hours
    _global_flag = os.path.expanduser("~/.fyso/last-limit-hit")
    _dedup_hours = 5
    if os.path.exists(_global_flag):
        try:
            _age_h = (datetime.datetime.now().timestamp() - os.path.getmtime(_global_flag)) / 3600
            if _age_h < _dedup_hours:
                if _dbg:
                    open(_dbg_log, "a").write(f"STOP_FAILURE: global flag age={_age_h:.1f}h < {_dedup_hours}h, skipping\n")
                sys.exit(0)
        except:
            pass
    # Create flag file to prevent duplicate detection (also blocks usage_limit_check fallback)
    if session_id:
        try: open(flag_file, 'w').close()
        except: pass
    # Get claude account
    ca = ""
    try:
        r = subprocess.run(["claude", "auth", "status", "--json"], capture_output=True, text=True, timeout=3)
        if r.returncode == 0:
            ca = json.loads(r.stdout).get("email", "")
    except: pass
    # Extract reset time from last_assistant_message
    _lam = hook.get("last_assistant_message", "")
    _reset_m = re.search(r'resets\s+(\d+(?::\d+)?(?:am|pm))\s+\(([^)]+)\)', _lam, re.IGNORECASE)
    _reset_at = f"{_reset_m.group(1)} ({_reset_m.group(2)})" if _reset_m else None
    # Normalize model
    if not model or model == "<synthetic>":
        model = "claude-opus-4-6"
    mf = "opus" if "opus" in model else "sonnet" if "sonnet" in model else "haiku" if "haiku" in model else "opus"
    d = {
        "event": "usage_limit_hit",
        "detail": f"stop_failure: {error_type}" + (f" - {str(error_message)[:100]}" if error_message else ""),
        "limit_reset_at": _reset_at or None,
        "user": user_email or getpass.getuser(),
        "session_id": session_id or None,
        "claude_account": ca or None,
        "model": model or "claude-opus-4-6",
        "model_family": mf,
        "tokens": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_tokens": 0,
        "cache_read_tokens": 0,
        "session_tokens": session_tokens,
        "session_input_tokens": session_input,
        "session_output_tokens": session_output,
        "session_cache_creation_tokens": session_cache_creation,
        "session_cache_read_tokens": session_cache_read,
        "cwd": hook.get("cwd", os.getcwd()) or None,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    d = {k: v for k, v in d.items() if v is not None}
    if _dbg:
        open(_dbg_log, "a").write(f"STOP_FAILURE: sending payload user={d.get('user')} ca={d.get('claude_account')} session={d.get('session_id','')[:8]}\n")
    try:
        req = urllib.request.Request(
            f"{api_url}/api/entities/tracking/records",
            data=json.dumps(d).encode(),
            headers={"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant, "Content-Type": "application/json"},
            method="POST",
        )
        # Update global cross-session flag
        try: open(_global_flag, 'w').close()
        except: pass
        resp = urllib.request.urlopen(req, timeout=5)
        if _dbg:
            open(_dbg_log, "a").write(f"STOP_FAILURE: sent OK {resp.status}\n")
        _date_str = datetime.datetime.now().strftime("%Y-%m-%d")
        upsert_tracking_daily(
            api_url, token, tenant, _dbg_log,
            _date_str, user_email or getpass.getuser(), "usage_limit_hit", ca,
            model, 0, 0, 0, 0, 0, False, None,
        )
    except Exception as e:
        if _dbg:
            open(_dbg_log, "a").write(f"STOP_FAILURE: send error {e}\n")
    sys.exit(0)

# Handle UserPromptSubmit: detect usage limit from <synthetic> entries in transcript
# Fires on the 2nd blocked message — kept as FALLBACK if StopFailure doesn't fire
if os.path.exists(os.path.expanduser("~/.fyso/debug")):
    open(os.path.expanduser("~/.fyso/hook-debug.log"), "a").write(f"REACHED_HANDLER: event_type={repr(event_type)} model={repr(model)}\n")
if event_type == "usage_limit_check":
    flag_file = f"/tmp/fyso-limit-hit-{session_id}"
    _dbg = os.path.exists(os.path.expanduser("~/.fyso/debug"))
    _dbg_log = os.path.expanduser("~/.fyso/hook-debug.log")
    if session_id and os.path.exists(flag_file):
        try:
            _sess_age_h = (datetime.datetime.now().timestamp() - os.path.getmtime(flag_file)) / 3600
        except:
            _sess_age_h = 0
        if _sess_age_h < 5:
            if _dbg:
                open(_dbg_log, "a").write(f"LIMIT_CHECK: flag exists age={_sess_age_h:.1f}h < 5h, skipping\n")
            sys.exit(0)
        if _dbg:
            open(_dbg_log, "a").write(f"LIMIT_CHECK: flag expired age={_sess_age_h:.1f}h, re-reporting\n")
    # Cross-session dedup: skip if a limit was already reported within the last 5 hours
    _global_flag = os.path.expanduser("~/.fyso/last-limit-hit")
    _dedup_hours = 5
    if os.path.exists(_global_flag):
        try:
            _age_h = (datetime.datetime.now().timestamp() - os.path.getmtime(_global_flag)) / 3600
            if _age_h < _dedup_hours:
                if _dbg:
                    open(_dbg_log, "a").write(f"LIMIT_CHECK: global flag age={_age_h:.1f}h < {_dedup_hours}h, skipping\n")
                sys.exit(0)
        except:
            pass
    hit = False
    _reset_at2 = None
    if transcript_path and os.path.exists(transcript_path):
        try:
            lines = open(transcript_path, encoding="utf-8", errors="replace").readlines()
            if _dbg:
                open(_dbg_log, "a").write(f"LIMIT_CHECK: scanning {len(lines)} lines\n")
            for raw_line in lines[-50:]:
                try:
                    entry = json.loads(raw_line.strip())
                    msg = entry.get("message", {})
                    if not isinstance(msg, dict): continue
                    if msg.get("model") != "<synthetic>": continue
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        txt_orig = " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
                    else:
                        txt_orig = (content if isinstance(content, str) else "")
                    txt = txt_orig.lower()
                    if _dbg:
                        open(_dbg_log, "a").write(f"LIMIT_CHECK: synthetic found txt={repr(txt[:100])}\n")
                    if any(kw in txt for kw in USAGE_LIMIT_KEYWORDS):
                        hit = True
                        _reset_m2 = re.search(r'resets\s+(\d+(?::\d+)?(?:am|pm))\s+\(([^)]+)\)', txt_orig, re.IGNORECASE)
                        _reset_at2 = f"{_reset_m2.group(1)} ({_reset_m2.group(2)})" if _reset_m2 else None
                        break
                except: continue
        except: pass
    if _dbg:
        open(_dbg_log, "a").write(f"LIMIT_CHECK: hit={hit}\n")
    if not hit:
        sys.exit(0)
    if session_id:
        try: open(flag_file, 'w').close()
        except: pass
    ca = ""
    try:
        r = subprocess.run(["claude", "auth", "status", "--json"], capture_output=True, text=True, timeout=3)
        if r.returncode == 0:
            ca = json.loads(r.stdout).get("email", "")
    except: pass
    # model may be "<synthetic>" if transcript only has blocked responses — normalize it
    if not model or model == "<synthetic>":
        model = "claude-opus-4-6"
    mf = "opus" if "opus" in model else "sonnet" if "sonnet" in model else "haiku" if "haiku" in model else "opus"
    d = {
        "event": "usage_limit_hit",
        "detail": "usage limit detected",
        "limit_reset_at": _reset_at2 or None,
        "user": user_email or getpass.getuser(),
        "session_id": session_id or None,
        "claude_account": ca or None,
        "model": model or "claude-opus-4-6",
        "model_family": mf,
        "tokens": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_tokens": 0,
        "cache_read_tokens": 0,
        "session_tokens": session_tokens,
        "session_input_tokens": session_input,
        "session_output_tokens": session_output,
        "session_cache_creation_tokens": session_cache_creation,
        "session_cache_read_tokens": session_cache_read,
        "cwd": hook.get("cwd", os.getcwd()) or None,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    d = {k: v for k, v in d.items() if v is not None}
    if _dbg:
        open(_dbg_log, "a").write(f"LIMIT_CHECK: sending payload user={d.get('user')} ca={d.get('claude_account')} session={d.get('session_id','')[:8]}\n")
    try:
        req = urllib.request.Request(
            f"{api_url}/api/entities/tracking/records",
            data=json.dumps(d).encode(),
            headers={"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant, "Content-Type": "application/json"},
            method="POST",
        )
        # Update global cross-session flag
        try: open(_global_flag, 'w').close()
        except: pass
        resp = urllib.request.urlopen(req, timeout=5)
        if _dbg:
            open(_dbg_log, "a").write(f"LIMIT_CHECK: sent OK {resp.status}\n")
        _date_str2 = datetime.datetime.now().strftime("%Y-%m-%d")
        upsert_tracking_daily(
            api_url, token, tenant, _dbg_log,
            _date_str2, user_email or getpass.getuser(), "usage_limit_hit", ca,
            model, 0, 0, 0, 0, 0, False, None,
        )
    except Exception as e:
        if _dbg:
            open(_dbg_log, "a").write(f"LIMIT_CHECK: send error {e}\n")
    sys.exit(0)

if event_type == "session_update":
    hit = False

    # Only detect usage limit via <synthetic> transcript entries.
    # last_assistant_message is NOT used: it contains the real assistant's text, which
    # can mention limit-related phrases innocuously and cause false positives.
    if transcript_path and os.path.exists(transcript_path):
        flag_file = f"/tmp/fyso-limit-hit-{session_id}"
        if not (session_id and os.path.exists(flag_file)):
            try:
                lines = open(transcript_path, encoding="utf-8", errors="replace").readlines()
                for raw_line in lines[-50:]:
                    try:
                        entry = json.loads(raw_line.strip())
                        msg = entry.get("message", {})
                        if not isinstance(msg, dict): continue
                        if msg.get("model") != "<synthetic>": continue
                        content = msg.get("content", "")
                        if isinstance(content, list):
                            txt = " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text").lower()
                        else:
                            txt = (content if isinstance(content, str) else "").lower()
                        if any(kw in txt for kw in USAGE_LIMIT_KEYWORDS):
                            hit = True
                            break
                    except: continue
            except: pass

    if hit:
        event_type = "usage_limit_hit"
        if session_id:
            try: open(f"/tmp/fyso-limit-hit-{session_id}", 'w').close()
            except: pass

# 2. Rate limit / overloaded: tool_response contains an error object (PostToolUse)
if event_type == "agent_dispatch":
    if isinstance(tool_response, dict) and tool_response.get("type") == "error":
        err_type = (tool_response.get("error") or {}).get("type", "")
        if err_type == "rate_limit_error":
            event_type = "rate_limit_hit"
        elif err_type == "overloaded_error":
            event_type = "overloaded_hit"

# Build detail for session_end/session_update
if event_type in ("session_end", "session_update", "usage_limit_hit"):
    if _last_text:
        _summary = _last_text.split("\n")[0][:120]
    elif _tools_used:
        _summary = "Used: " + ", ".join(_tools_used[-5:])
    detail = _summary if _summary else "session update"
    # For session events, clear per-event tokens (session-level is what matters)
    tokens = 0
    input_tokens = 0
    output_tokens = 0
    cache_creation_tokens = 0
    cache_read_tokens = 0

# Model family (for business rule cost calculation server-side)
model_family = "opus" if "opus" in model else "sonnet" if "sonnet" in model else "haiku" if "haiku" in model else "opus"

# User
user = user_email or getpass.getuser()

# Claude account email (which Claude account is active in this session)
claude_account = ""
try:
    result = subprocess.run(
        ["claude", "auth", "status", "--json"],
        capture_output=True, text=True, timeout=3
    )
    if result.returncode == 0:
        auth_info = json.loads(result.stdout)
        claude_account = auth_info.get("email", "")
except Exception:
    pass

# Build payload
data = {
    "event": event_type,
    "tool": tool_name or None,
    "agent": agent or None,
    "detail": detail or None,
    "team_name": team_name or None,
    "user": user or None,
    "claude_account": claude_account or None,
    "session_id": session_id or None,
    "model": model or None,
    "model_family": model_family or None,
    "message_id": message_id or None,
    "tokens": tokens,
    "input_tokens": input_tokens,
    "output_tokens": output_tokens,
    "cache_creation_tokens": cache_creation_tokens,
    "cache_read_tokens": cache_read_tokens,
    "session_tokens": session_tokens,
    "session_input_tokens": session_input,
    "session_output_tokens": session_output,
    "session_cache_creation_tokens": session_cache_creation,
    "session_cache_read_tokens": session_cache_read,
    "cwd": hook.get("cwd", os.getcwd()) or None,
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
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
_main_resp_body = None
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
    _main_resp_body = resp.read().decode()
    if os.path.exists(debug_path):
        with open(log_path, "a") as dl:
            dl.write(f"RESPONSE: {resp.status} {_main_resp_body[:200]}\n\n")
except Exception as e:
    if os.path.exists(debug_path):
        log_path = os.path.expanduser("~/.fyso/hook-debug.log")
        with open(log_path, "a") as dl:
            dl.write(f"ERROR: {e}\n\n")

# Dual-write to tracking_daily is DISABLED (2026-04-13).
#
# Reason: the Fyso business rule on tracking_daily accumulates values on PUT
# (designed for delta-only writes). The plugin was sending full accumulated
# totals, causing each PUT to roughly double the delta — resulting in inflated
# numbers visible in the dashboard.
#
# tracking_daily is now rebuilt exclusively from raw tracking events via:
#   - Auto-refresh on page load (refreshTodayFast) — corrects today
#   - "Actualizar" button (refreshTrackingDaily) — corrects last N days
#
# The plugin's only responsibility is writing raw events to the tracking table,
# which it does correctly and completely.
PYEOF

# Cleanup
rm -f "$TMPFILE" 2>/dev/null
exit 0
