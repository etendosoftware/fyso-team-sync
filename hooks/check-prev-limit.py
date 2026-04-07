#!/usr/bin/env python3
"""Check previous sessions for unreported usage limit hits.
Called from tracking.sh session_start via background subprocess.
Expects P dict with: transcript_dir, session_id, api_url, token, tenant, user_email, cwd
"""
import json, os, sys, datetime, getpass, subprocess, glob

try:
    import urllib.request
except:
    sys.exit(0)

_dbg = os.path.exists(os.path.expanduser("~/.fyso/debug"))
_dbg_log = os.path.expanduser("~/.fyso/hook-debug.log")

if _dbg:
    open(_dbg_log, "a").write("SESSION_START_BG: checking previous sessions\n")

KEYWORDS = ("usage limit", "out of extra usage", "you're out of", "out of claude", "plan limit", "quota exceeded")

transcript_dir = P["transcript_dir"]
session_id = P["session_id"]
api_url = P["api_url"]
token = P["token"]
tenant = P["tenant"]
user_email = P["user_email"]
cwd = P["cwd"]

if not transcript_dir:
    sys.exit(0)

transcripts = sorted(glob.glob(os.path.join(transcript_dir, "*.jsonl")), key=os.path.getmtime, reverse=True)

if _dbg:
    open(_dbg_log, "a").write(f"SESSION_START_BG: found {len(transcripts)} transcripts, checking top 5\n")

for tf in transcripts[:5]:
    tf_session = os.path.basename(tf).replace(".jsonl", "")
    if tf_session == session_id:
        continue
    flag_file = f"/tmp/fyso-limit-hit-{tf_session}"
    if os.path.exists(flag_file):
        if _dbg:
            open(_dbg_log, "a").write(f"SESSION_START_BG: {tf_session[:8]} already flagged, skip\n")
        continue
    # Read only the tail of the file (last 20KB)
    try:
        fsize = os.path.getsize(tf)
        with open(tf, encoding="utf-8", errors="replace") as fh:
            if fsize > 20000:
                fh.seek(fsize - 20000)
                fh.readline()  # skip partial line
            tail_lines = fh.readlines()
    except Exception as e:
        if _dbg:
            open(_dbg_log, "a").write(f"SESSION_START_BG: error reading {tf_session[:8]}: {e}\n")
        continue

    if _dbg:
        open(_dbg_log, "a").write(f"SESSION_START_BG: checking {tf_session[:8]} ({len(tail_lines)} tail lines)\n")

    for raw_line in tail_lines[-30:]:
        try:
            entry = json.loads(raw_line.strip())
            msg = entry.get("message", {})
            if not isinstance(msg, dict):
                continue
            if msg.get("model") != "<synthetic>":
                continue
            content = msg.get("content", "")
            if isinstance(content, list):
                txt = " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text").lower()
            else:
                txt = (content if isinstance(content, str) else "").lower()
            if any(kw in txt for kw in KEYWORDS):
                if _dbg:
                    open(_dbg_log, "a").write(f"SESSION_START_BG: MATCH in {tf_session[:8]} txt={repr(txt[:80])}\n")
                try:
                    open(flag_file, "w").close()
                except:
                    pass
                ca = ""
                try:
                    r = subprocess.run(["claude", "auth", "status", "--json"], capture_output=True, text=True, timeout=3)
                    if r.returncode == 0:
                        ca = json.loads(r.stdout).get("email", "")
                except:
                    pass
                d = {
                    "event": "usage_limit_hit",
                    "detail": f"detected on next session_start: {txt[:100]}",
                    "user": user_email or getpass.getuser(),
                    "session_id": tf_session,
                    "claude_account": ca or None,
                    "model": "claude-opus-4-6",
                    "model_family": "opus",
                    "tokens": 0, "input_tokens": 0, "output_tokens": 0,
                    "cache_creation_tokens": 0, "cache_read_tokens": 0,
                    "session_tokens": 0, "session_input_tokens": 0, "session_output_tokens": 0,
                    "session_cache_creation_tokens": 0, "session_cache_read_tokens": 0,
                    "cwd": cwd or None,
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
                }
                d = {k: v for k, v in d.items() if v is not None}
                try:
                    req = urllib.request.Request(
                        f"{api_url}/api/entities/tracking/records",
                        data=json.dumps(d).encode(),
                        headers={"Authorization": f"Bearer {token}", "X-Tenant-ID": tenant, "Content-Type": "application/json"},
                        method="POST",
                    )
                    resp = urllib.request.urlopen(req, timeout=5)
                    if _dbg:
                        open(_dbg_log, "a").write(f"SESSION_START_BG: sent OK {resp.status} for {tf_session[:8]}\n")
                except Exception as e:
                    if _dbg:
                        open(_dbg_log, "a").write(f"SESSION_START_BG: send error {e}\n")
                sys.exit(0)  # done, only report first match
        except:
            continue

if _dbg:
    open(_dbg_log, "a").write("SESSION_START_BG: no unreported limits found\n")
