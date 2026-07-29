#!/usr/bin/env node
// fyso-team-sync — Hook dispatcher (Node-only, cross-platform) v4.0
//
// Single implementation for Unix and Windows: Node is guaranteed on any
// machine that runs Claude Code, so there is no more per-OS branching and no
// more bash/python scripts. Telemetry now goes to fyso-business
// (`POST {api_url}/api/uso/eventos`) with the user's personal token — the
// server resolves organization and identity from the token, so there is no
// tenant header anywhere anymore.
//
// The network write (and the session-state bookkeeping gated on its
// success) always happens in a short-lived detached child process, never in
// the hook's own foreground path: Claude Code gives a hook ~5s and our POST
// can take longer than that. The foreground path only reads local files
// (transcript, config) and hands off a small JSON blob to the background
// sender before returning.
//
// A 401/403 on that POST means the personal token is dead (revoked, or
// replaced by a newer one) — unlike a network error, retrying won't help, so
// sendUsageEvent records it in session-state.json (`connection.broken`) and
// team_update_check (the only path that talks to the user, on every
// UserPromptSubmit) surfaces it once per session via warnIfConnectionBroken,
// taking priority over the plugin-version notice below it.
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync, spawn, execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

const HOOKS_DIR = __dirname;
const FYSO_DIR = path.join(os.homedir(), '.fyso');
const CONFIG_PATH = path.join(FYSO_DIR, 'config.json');
const SESSION_STATE_PATH = path.join(FYSO_DIR, 'session-state.json');
const SESSION_STATE_LOCK = `${SESSION_STATE_PATH}.lock`;
const REPO_CACHE_PATH = path.join(FYSO_DIR, 'repo-cache.json');
const CLAUDE_ACCOUNT_CACHE_PATH = path.join(FYSO_DIR, 'claude-account-cache.json');
const DEBUG_FLAG_PATH = path.join(FYSO_DIR, 'debug');
const DEBUG_LOG_PATH = path.join(FYSO_DIR, 'hook-debug.log');
const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024; // hard cap; rotates to .old past this
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const ACCOUNT_CACHE_FALLBACK_TTL_MS = 5 * 60 * 1000; // used only when credentials file is unreadable (e.g. macOS Keychain-only)
const REPO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 1000;
const TRANSCRIPT_TAIL_READ_BYTES = 20000; // shared with the usage-limit tail read below

const USAGE_LIMIT_KEYWORDS = [
  'usage limit reached', 'out of extra usage', "you've reached your usage",
  'usage limit', "you're out of", 'limit has been reached', 'no remaining',
  'out of claude', 'monthly usage', 'plan limit', 'tokens remaining',
  'run out of', 'exhausted your', 'quota exceeded', 'quota has been',
];

const EVENT_TYPE = process.argv[2] || 'session';

// Read all stdin synchronously — fd 0 works cross-platform in Node. Not used
// by the internal subcommands (heartbeat_run/__send_event/__check_prev_limit),
// which receive their data via a temp file instead.
let stdinData = '';
try { stdinData = fs.readFileSync(0, 'utf8').trim(); } catch (e) {}

main().catch(() => {}).finally(() => process.exit(0));

async function main() {
  ensureFysoDir();
  rotateDebugLogIfNeeded();

  if (EVENT_TYPE === 'heartbeat_launch') { handleHeartbeatLaunch(); return; }
  if (EVENT_TYPE === 'heartbeat_run') { await handleHeartbeatRun(); return; }
  if (EVENT_TYPE === 'heartbeat_kill') { handleHeartbeatKill(); return; }
  if (EVENT_TYPE === 'team_update_check') { await handleTeamUpdateCheck(); return; }
  if (EVENT_TYPE === '__send_event') { await handleSendEvent(); return; }
  if (EVENT_TYPE === '__check_prev_limit') { await handleCheckPrevLimit(); return; }

  await handleTrackingEvent();
}

// ─── SessionStart: heartbeat lifecycle ───────────────────────────────────────
function handleHeartbeatLaunch() {
  const tmpf = path.join(os.tmpdir(), `fyso-hb-${Date.now()}-${process.pid}.json`);
  try { fs.writeFileSync(tmpf, stdinData || '{}'); } catch (e) { return; }
  try {
    const child = spawn(process.execPath, [__filename, 'heartbeat_run', tmpf], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (e) {}
}

function handleHeartbeatKill() {
  const pidFile = path.join(FYSO_DIR, 'heartbeat.pid');
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    if (pid) process.kill(pid);
  } catch (e) {}
  try { fs.unlinkSync(pidFile); } catch (e) {}
}

// Long-running detached process: reads the transcript every 5 minutes and
// reports a `heartbeat` usage event, until the transcript file disappears
// (session ended). Consolidates what used to be heartbeat.sh (Unix) and the
// Windows-only Node loop into the one implementation.
async function handleHeartbeatRun() {
  const dataFile = process.argv[3] || '';
  let sessionData = {};
  try { sessionData = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) {}
  try { fs.unlinkSync(dataFile); } catch (e) {}

  const sessionId = sessionData.session_id || '';
  const transcriptPath = sessionData.transcript_path || '';
  const cwd = sessionData.cwd || '';
  if (!sessionId || !transcriptPath) return;

  const pidFile = path.join(FYSO_DIR, 'heartbeat.pid');
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch (e) {}

  let teamName = '';
  try {
    const tp = path.join(cwd, '.fyso', 'team.json');
    if (fs.existsSync(tp)) teamName = JSON.parse(fs.readFileSync(tp, 'utf8')).team_name || '';
  } catch (e) {}

  while (true) {
    await sleep(5 * 60 * 1000);
    if (!fs.existsSync(transcriptPath)) break;

    const scan = scanTranscript(transcriptPath, { collectDetail: true, detailWindow: 50 });
    await sendUsageEvent({
      event: 'heartbeat',
      detail: buildActivityDetail(scan),
      teamName: teamName || undefined,
      sessionId,
      model: scan.model || undefined,
      cwd: cwd || undefined,
      tokensNow: scan.totals,
      timestamp: new Date().toISOString(),
    });
  }

  try { fs.unlinkSync(pidFile); } catch (e) {}
}

// ─── UserPromptSubmit: team version check ────────────────────────────────────
// Ports check-team-updates.sh, now pointed at fyso-business's `/api/equipos`
// catalog (ADR 0028) instead of the old fyso raw-entities API — that endpoint
// (`GET /api/equipos/[id]/version`) is documented server-side as built
// specifically for this hook and takes the same Bearer-token-only auth as
// the telemetry endpoint, no tenant header.
async function handleTeamUpdateCheck() {
  const cfg = readConfig();
  if (!cfg) return;

  let hook = {};
  try { hook = JSON.parse(stdinData); } catch (e) {}

  const sessionId = hook.session_id || '';

  // Broken-credential warning takes priority over (and, while active,
  // suppresses) the team-version check below: it has its own dedup, checked
  // first and on every prompt, precisely because a token can die mid-session
  // — after this session's version-check flag (right below) already got set
  // on an earlier prompt. If we gated this on that same flag, a mid-session
  // revocation would never surface at all.
  if (warnIfConnectionBroken(sessionId)) return;

  const flagFile = path.join(
    os.tmpdir(),
    sessionId ? `fyso-version-check-${sessionId}` : `fyso-version-check-${process.ppid}`
  );
  if (fs.existsSync(flagFile)) return;
  try { fs.writeFileSync(flagFile, ''); } catch (e) {}

  const startDir = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();
  let dir = startDir;
  let teamFile = null;
  while (dir && dir !== path.dirname(dir)) {
    const candidate = path.join(dir, '.fyso', 'team.json');
    if (fs.existsSync(candidate)) { teamFile = candidate; break; }
    dir = path.dirname(dir);
  }
  if (!teamFile) return;

  let team = {};
  try { team = JSON.parse(fs.readFileSync(teamFile, 'utf8')); } catch (e) { return; }
  const teamId = team.team_id;
  const teamName = team.team_name;
  const localVersion = parseInt(team.version || 0, 10);
  if (!teamId) return;

  try {
    const resp = await httpRequest('GET', `${cfg.api_url}/api/equipos/${teamId}/version`, null, {
      Authorization: `Bearer ${cfg.token}`,
    });
    if (resp.status < 200 || resp.status >= 300) return;
    const data = JSON.parse(resp.body);
    const remoteVersion = parseInt(data.version ?? localVersion, 10);
    if (remoteVersion > localVersion) {
      process.stdout.write(
        `[fyso-team-sync] Hay una nueva versión del equipo "${teamName}" disponible ` +
        `(local: v${localVersion}, remota: v${remoteVersion}). ` +
        `IMPORTANTE: antes de responder al usuario, avisale en una línea que hay una actualización ` +
        `disponible y que puede correr /sync-team para actualizar los agentes locales.\n`
      );
    }
  } catch (e) { dbg('team_update_check', `error: ${e.message}`); }
}

// Reads the connection marker sendUsageEvent maintains in session-state.json
// and, if it shows a *previously working* connection that a 401/403 has since
// broken, prints a one-line, model-facing warning — same channel/shape as the
// version-check notice above. Returns whether a broken connection is
// currently on record (regardless of whether this call actually printed
// anything), so the caller can skip the version check while it's true.
//
// `everConnected` is what tells "never configured / stale api_url that 401s
// everything" (never true, so we stay quiet — a person who never had a good
// connection shouldn't be told theirs "stopped working") apart from "had one,
// it broke" (everConnected true + connection.broken true — worth a warning).
function warnIfConnectionBroken(sessionId) {
  const state = readJsonSafe(SESSION_STATE_PATH, {});
  const conn = state.connection || {};
  if (!conn.broken || !state.everConnected) return false;

  // Own dedup, separate from the version-check flag above: printed at most
  // once per session, but checked on every prompt (cheap local read) so a
  // mid-session revocation is caught on the very next prompt instead of
  // waiting for a session that hasn't run its version check yet.
  const warnFlag = path.join(
    os.tmpdir(),
    sessionId ? `fyso-conn-broken-warned-${sessionId}` : `fyso-conn-broken-warned-${process.ppid}`
  );
  if (fs.existsSync(warnFlag)) return true;
  try { fs.writeFileSync(warnFlag, ''); } catch (e) {}

  process.stdout.write(
    '[fyso-team-sync] Tu conexión con fyso-business dejó de funcionar (la credencial fue revocada o reemplazada). ' +
    'IMPORTANTE: antes de responder al usuario, avisale en una línea que su conexión con fyso-business dejó de ' +
    'funcionar porque la credencial fue revocada o reemplazada, que puede correr /sync-team para reconectar, y que ' +
    'mientras tanto no se está registrando el uso de sus agentes.\n'
  );
  return true;
}

// ─── Main tracking path: session_start, agent_dispatch, subagent_start/stop,
//     stop_failure, usage_limit_check, session_update ──────────────────────
async function handleTrackingEvent() {
  let hook = {};
  try { hook = JSON.parse(stdinData); } catch (e) {}

  const toolResponse = (typeof hook.tool_response === 'object' && hook.tool_response) || {};
  const toolInput = (typeof hook.tool_input === 'object' && hook.tool_input) || {};
  const toolName = hook.tool_name || '';
  const transcriptPath = hook.transcript_path || '';
  const hookCwd = hook.cwd || process.cwd();
  const agentId = hook.agent_id || '';
  const agentType = hook.agent_type || '';
  // Only present on SubagentStop (verified against a real payload) — the
  // subagent's own transcript, as opposed to `transcriptPath` above, which is
  // always the orchestrator session's.
  const agentTranscriptPath = hook.agent_transcript_path || '';

  let sessionId = hook.session_id || '';
  if (!sessionId) {
    const key = `${process.ppid}-${new Date().toISOString().split('T')[0]}`;
    sessionId = crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
  }

  // Agent hint from tool_input — only meaningful for the PostToolUse "Agent"
  // matcher (agent_dispatch, and its rate/overload promotions below), which
  // is the Task tool call, not the SubagentStart/SubagentStop hook events.
  const agentHint = toolInput.subagent_type || toolInput.name || '';

  // Detail: only toolInput.description, NEVER toolInput.prompt (that's the
  // full instruction text, can contain anything — description is a label).
  let detail;
  if (EVENT_TYPE === 'session_start') {
    detail = 'session start';
  } else if (typeof toolInput.description === 'string' && toolInput.description) {
    detail = toolInput.description.length > 200
      ? `${toolInput.description.slice(0, 200)}...`
      : toolInput.description;
  }

  let teamName = '';
  try {
    const tp = path.join(hookCwd, '.fyso', 'team.json');
    if (fs.existsSync(tp)) teamName = JSON.parse(fs.readFileSync(tp, 'utf8')).team_name || '';
  } catch (e) {}

  let messageId = '';
  if (toolResponse.id || toolResponse.requestId) messageId = toolResponse.id || toolResponse.requestId;
  if (!messageId) messageId = hook.requestId || '';

  // ── stop_failure: immediate usage-limit detection via API error ──────────
  // Both flag files below only gate re-detection — they are no longer
  // written here. Writing them before dispatchSend meant a failed background
  // POST (timeout, 401, fyso being flaky) still suppressed detection for 5h,
  // losing the report for good even though nothing was ever confirmed sent.
  // sendUsageEvent now writes them itself, and only after a 2xx — same
  // "only advance on success" rule as the token-delta marker.
  if (EVENT_TYPE === 'stop_failure') {
    const flagFile = path.join(os.tmpdir(), `fyso-limit-hit-${sessionId}`);
    const globalFlag = path.join(FYSO_DIR, `last-limit-hit-${currentAccountKey()}`);
    if (sessionId && fs.existsSync(flagFile) && ageHours(flagFile) < 5) return;
    if (fs.existsSync(globalFlag) && ageHours(globalFlag) < 5) return;

    const scan = scanTranscript(transcriptPath, { collectDetail: false });
    const model = scan.model || 'claude-opus-4-6';

    const lam = hook.last_assistant_message || '';
    const resetMatch = lam.match(/resets\s+(\d+(?::\d+)?(?:am|pm))\s+\(([^)]+)\)/i);
    const resetAt = resetMatch ? `${resetMatch[1]} (${resetMatch[2]})` : undefined;
    const errorType = hook.error_type || '';
    const errorMsg = hook.error_message || hook.error || '';

    dispatchSend({
      event: 'usage_limit_hit',
      detail: `stop_failure: ${errorType}${errorMsg ? ` - ${String(errorMsg).slice(0, 100)}` : ''}`,
      limitResetAt: resetAt,
      sessionId,
      model,
      cwd: hookCwd,
      tokensNow: scan.totals,
      forceAccountRefresh: true,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // ── usage_limit_check: fallback detection via <synthetic> transcript entries ──
  // Same fix as stop_failure above: no write-before-dispatch here anymore.
  if (EVENT_TYPE === 'usage_limit_check') {
    const flagFile = path.join(os.tmpdir(), `fyso-limit-hit-${sessionId}`);
    const globalFlag = path.join(FYSO_DIR, `last-limit-hit-${currentAccountKey()}`);
    if (sessionId && fs.existsSync(flagFile) && ageHours(flagFile) < 5) return;
    if (fs.existsSync(globalFlag) && ageHours(globalFlag) < 5) return;

    const { hit, resetAt } = detectUsageLimit(transcriptPath, USAGE_LIMIT_KEYWORDS);
    if (!hit) return;

    const scan = scanTranscript(transcriptPath, { collectDetail: false });
    let model = scan.model;
    if (!model || model === '<synthetic>') model = 'claude-opus-4-6';

    dispatchSend({
      event: 'usage_limit_hit',
      detail: 'usage limit detected',
      limitResetAt: resetAt,
      sessionId,
      model,
      cwd: hookCwd,
      tokensNow: scan.totals,
      forceAccountRefresh: true,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // ── Remaining events: session_start, agent_dispatch, subagent_start/stop, session_update ──
  const needsCollectDetail = ['session_update', 'session_end', 'usage_limit_hit'].includes(EVENT_TYPE);
  const shouldSleep = ['session_update', 'session_end'].includes(EVENT_TYPE);
  // Give Claude a moment to finish writing the transcript before reading it.
  if (shouldSleep) await sleep(1000);

  const scan = scanTranscript(transcriptPath, { collectDetail: needsCollectDetail, detailWindow: 50 });
  let model = scan.model;

  let actualEvent = EVENT_TYPE;

  // session_update: detect a usage limit from <synthetic> entries in the transcript.
  // Same flag file as stop_failure/usage_limit_check above (and the same fix:
  // sendUsageEvent is the one that writes it, only on success), so a failed
  // dispatch here is retried on the next Stop instead of being suppressed
  // for 5h with nothing actually reported.
  if (EVENT_TYPE === 'session_update') {
    const flagFile = path.join(os.tmpdir(), `fyso-limit-hit-${sessionId}`);
    if (!(sessionId && fs.existsSync(flagFile))) {
      const { hit } = detectUsageLimit(transcriptPath, USAGE_LIMIT_KEYWORDS);
      if (hit) actualEvent = 'usage_limit_hit';
    }
  }

  // agent_dispatch: a tool_response error object means a rate/overload limit, not a normal dispatch.
  if (EVENT_TYPE === 'agent_dispatch' && toolResponse.type === 'error') {
    const errType = (toolResponse.error || {}).type || '';
    if (errType === 'rate_limit_error') actualEvent = 'rate_limit_hit';
    else if (errType === 'overloaded_error') actualEvent = 'overloaded_hit';
  }

  // ── Model for subagent-dispatch events: never the orchestrator's ─────────
  // `model` above (from scanTranscript(transcriptPath)) is the ORCHESTRATOR
  // session's model. That's correct for session_start/session_update/
  // usage_limit_hit, but a subagent can run on a different model than
  // whoever dispatched it — tagging it with the orchestrator's model
  // mis-tarifies the whole event (verified live: a "ui-app" dispatch that
  // ran end-to-end on claude-sonnet-5 got reported as claude-opus-5 because
  // this code read the main session's transcript instead of the subagent's).
  //
  // For these three event types we either read the real source or leave
  // `model` unset — never guess. `clean()` in sendUsageEvent drops undefined
  // fields, so an unset model here means the event goes out without one; the
  // server already treats an unknown model as "cost not computed" rather
  // than inventing a price, and an absent cost is honest where a wrong one
  // contaminates totals.
  if (EVENT_TYPE === 'agent_dispatch') {
    // Fired synchronously right after the Task tool call returns (PostToolUse,
    // matcher "Agent") — before the subagent has necessarily produced any
    // transcript of its own, so there's nothing on disk to read yet. Claude
    // Code already resolved the model for us: it's in this same event's
    // tool_response (verified against a real payload), so no extra file read
    // is needed at all.
    model = toolResponse.resolvedModel || undefined;
  } else if (EVENT_TYPE === 'subagent_start') {
    // SubagentStop carries agent_transcript_path; SubagentStart does not
    // (verified against a real payload) — and unlike agent_dispatch, this is
    // a native hook event with no tool_response to fall back on either. There
    // is no trustworthy source for the subagent's model yet at this point in
    // its lifecycle. Sending the session's model here would be the exact bug
    // this fix removes, just moved earlier — so it's left unset instead;
    // subagent_stop reports the real one once the transcript exists.
    model = undefined;
  } else if (EVENT_TYPE === 'subagent_stop') {
    model = resolveSubagentModel(agentTranscriptPath) || undefined;
  } else if (!model) {
    model = 'claude-opus-4-6';
  }

  // detail: dropped entirely for a plain session_update (conversation text,
  // not metadata); kept as a short summary when promoted to usage_limit_hit
  // or for session_end (both are informative, not raw chat).
  let finalDetail = detail;
  if (actualEvent === 'usage_limit_hit' || actualEvent === 'session_end') {
    finalDetail = buildSummaryDetail(scan);
  } else if (actualEvent === 'session_update') {
    finalDetail = undefined;
  }

  dispatchSend({
    event: actualEvent,
    tool: toolName || undefined,
    agentHint: agentHint || undefined,
    agentId: agentId || undefined,
    agentType: agentType || undefined,
    detail: finalDetail,
    teamName: teamName || undefined,
    sessionId,
    model,
    messageId: messageId || undefined,
    cwd: hookCwd,
    tokensNow: scan.totals,
    forceAccountRefresh: actualEvent === 'usage_limit_hit',
    timestamp: new Date().toISOString(),
  });

  // session_start: launch background check for unreported prev-session usage limits.
  if (EVENT_TYPE === 'session_start') {
    launchPrevLimitCheck(transcriptPath, sessionId, hookCwd);
  }
}

// Hands a raw event off to a detached `__send_event` child and returns
// immediately — the hook's own process never waits on the network.
function dispatchSend(rawEvent) {
  const tmpf = path.join(os.tmpdir(), `fyso-send-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmpf, JSON.stringify(rawEvent));
  } catch (e) { return; }
  try {
    const child = spawn(process.execPath, [__filename, '__send_event', tmpf], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (e) {}
}

async function handleSendEvent() {
  const dataFile = process.argv[3] || '';
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) {}
  try { fs.unlinkSync(dataFile); } catch (e) {}
  await sendUsageEvent(raw);
}

// ─── session_start: background check for unreported prev-session usage limits ──
// Ports check-prev-limit.py: scans the 5 most recently modified transcripts
// (other than the current session) in the same transcript directory for a
// <synthetic> message matching usage-limit keywords, and reports the first
// match found as a `usage_limit_hit` for that OLD session. Runs detached so
// it never counts against the session_start hook's own timeout.
function launchPrevLimitCheck(transcriptPath, sessionId, cwd) {
  const transcriptDir = transcriptPath ? path.dirname(transcriptPath) : '';
  if (!transcriptDir || !fs.existsSync(transcriptDir)) return;
  const tmpf = path.join(os.tmpdir(), `fyso-prevlimit-${sessionId}-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpf, JSON.stringify({ transcript_dir: transcriptDir, session_id: sessionId, cwd }));
    const child = spawn(process.execPath, [__filename, '__check_prev_limit', tmpf], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (e) {}
}

async function handleCheckPrevLimit() {
  const dataFile = process.argv[3] || '';
  let data = {};
  try { data = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) {}
  try { fs.unlinkSync(dataFile); } catch (e) {}

  const transcriptDir = data.transcript_dir || '';
  const sessionId = data.session_id || '';
  const cwd = data.cwd || '';
  if (!transcriptDir) return;

  const KEYWORDS = ['usage limit', 'out of extra usage', "you're out of", 'out of claude', 'plan limit', 'quota exceeded'];
  const MAX_AGE_MS = 6 * 60 * 60 * 1000;

  let files = [];
  try {
    files = fs.readdirSync(transcriptDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(transcriptDir, f));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch (e) { return; }

  // Clean up flag files older than 24h.
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (!f.startsWith('fyso-limit-hit-')) continue;
      const fp = path.join(os.tmpdir(), f);
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
      } catch (e) {}
    }
  } catch (e) {}

  for (const tf of files.slice(0, 5)) {
    const tfSession = path.basename(tf, '.jsonl');
    if (tfSession === sessionId) continue;

    let stat;
    try { stat = fs.statSync(tf); } catch (e) { continue; }
    if (Date.now() - stat.mtimeMs > MAX_AGE_MS) continue;

    const flagFile = path.join(os.tmpdir(), `fyso-limit-hit-${tfSession}`);
    try {
      const fd = fs.openSync(flagFile, 'wx');
      fs.closeSync(fd);
    } catch (e) { continue; } // already flagged by another check, or unwritable

    let tailLines = [];
    try {
      tailLines = readTailLines(tf, TRANSCRIPT_TAIL_READ_BYTES);
    } catch (e) { continue; }

    let matched = false;
    let matchedText = '';
    for (const rawLine of tailLines.slice(-30)) {
      try {
        const entry = JSON.parse(rawLine);
        const msg = entry.message || {};
        if (typeof msg !== 'object' || msg.model !== '<synthetic>') continue;
        const content = msg.content || '';
        let txt = '';
        if (Array.isArray(content)) {
          txt = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join(' ');
        } else if (typeof content === 'string') {
          txt = content;
        }
        if (KEYWORDS.some((kw) => txt.toLowerCase().includes(kw))) {
          matched = true;
          matchedText = txt;
          break;
        }
      } catch (e) {}
    }

    if (matched) {
      await sendUsageEvent({
        event: 'usage_limit_hit',
        detail: `detected on next session_start: ${matchedText.slice(0, 100)}`,
        sessionId: tfSession,
        model: 'claude-opus-4-6',
        cwd,
        tokensNow: { total: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        forceAccountRefresh: true,
        timestamp: new Date().toISOString(),
      });
      return; // report only the first match, same as the original script
    }
  }
}

// ─── The one place that resolves account/repo/version, computes the delta
//     against session-state, and POSTs to fyso-business ────────────────────
//
// All session-state.json reads/writes happen inside the file lock and in
// this function alone — the foreground hook path never touches that file,
// so a slow POST from one background sender can never make a *different*
// hook invocation block on the lock.
async function sendUsageEvent(raw) {
  const cfg = readConfig();
  if (!cfg) return;

  const claudeAccount = await resolveClaudeAccount({ forceRefresh: !!raw.forceAccountRefresh });
  const repo = resolveRepo(raw.cwd);
  const pluginVersion = resolvePluginVersion();
  const now = raw.tokensNow || { total: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const sid = raw.sessionId || '';

  await withFileLock(SESSION_STATE_LOCK, async () => {
    const state = readJsonSafe(SESSION_STATE_PATH, {});
    state.sessions = state.sessions || {};
    const existing = (sid && state.sessions[sid]) || {};
    const agents = Object.assign({}, existing.agents || {});

    // Resolve `agent`: tool_input hint (agent_dispatch/rate_limit_hit/overloaded_hit),
    // or agent_type (subagent_start), or a lookup by agent_id (subagent_stop,
    // where agent_type arrives empty — record it at start, resolve it at stop).
    let agent = raw.agentHint || raw.agentType || '';
    if (raw.event === 'subagent_start' && raw.agentId) {
      agents[raw.agentId] = { agentType: raw.agentType || agent || '', recordedAt: new Date().toISOString() };
    } else if (raw.event === 'subagent_stop' && raw.agentId && !agent) {
      const rec = agents[raw.agentId];
      if (rec) agent = rec.agentType || '';
    }

    const last = existing.tokens || { total: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    const delta = {
      total: Math.max(0, now.total - last.total),
      input: Math.max(0, now.input - last.input),
      output: Math.max(0, now.output - last.output),
      cacheCreation: Math.max(0, now.cacheCreation - last.cacheCreation),
      cacheRead: Math.max(0, now.cacheRead - last.cacheRead),
    };

    const payload = clean({
      event: raw.event,
      tool: raw.tool,
      agent: agent || undefined,
      agent_id: raw.agentId,
      detail: raw.detail,
      team_name: raw.teamName,
      claude_account: claudeAccount || undefined,
      session_id: sid || undefined,
      model: raw.model,
      message_id: raw.messageId,
      // Delta since the last successfully-reported marker for this session —
      // replaces the old "per-event tokens" (which were non-zero only for
      // agent_dispatch and thus captured ~0.3% of real consumption).
      tokens: delta.total,
      input_tokens: delta.input,
      output_tokens: delta.output,
      cache_creation_tokens: delta.cacheCreation,
      cache_read_tokens: delta.cacheRead,
      // Accumulated session total — the control number the server falls
      // back to for machines that haven't updated their plugin yet.
      session_tokens: now.total,
      session_input_tokens: now.input,
      session_output_tokens: now.output,
      session_cache_creation_tokens: now.cacheCreation,
      session_cache_read_tokens: now.cacheRead,
      cwd: raw.cwd,
      repo: repo || undefined,
      limit_reset_at: raw.limitResetAt,
      plugin_version: pluginVersion || undefined,
      timestamp: raw.timestamp,
    });

    dbg(raw.event, `PAYLOAD: ${JSON.stringify(payload)}`);

    let ok = false;
    let statusCode = null;
    try {
      const resp = await postJson(`${cfg.api_url}/api/uso/eventos`, payload, {
        Authorization: `Bearer ${cfg.token}`,
      });
      statusCode = resp.status;
      ok = resp.status >= 200 && resp.status < 300;
      dbg(raw.event, `RESPONSE: ${resp.status} ${String(resp.body).slice(0, 200)}`);
    } catch (e) {
      dbg(raw.event, `ERROR: ${e.message}`);
    }

    // Agent-id bookkeeping is local state, independent of send success — if
    // we dropped it on a failed POST we could never resolve the matching
    // subagent_stop later. The token marker, however, only advances on
    // success: a failed send means the next event's delta absorbs what this
    // one couldn't report, self-healing without a retry queue.
    if (sid) {
      state.sessions[sid] = state.sessions[sid] || {};
      state.sessions[sid].agents = agents;
      if (ok) state.sessions[sid].tokens = now;
      state.sessions[sid].updatedAt = new Date().toISOString();
    }

    // Credential vs. network failure: a 401/403 means the personal token
    // itself is dead (revoked, or replaced by a new one from the "Conectar
    // mis agentes" screen) — retrying won't fix that, so it's worth telling
    // the user (via team_update_check, see below). Anything else — a
    // network error (postJson threw, statusCode stays null) or a
    // non-auth HTTP status — is treated as transitory and left untouched:
    // the next event's delta absorbs what this one couldn't report, same
    // self-healing as always, no retry queue, no user-facing noise.
    //
    // `state.everConnected` / `state.connection` are top-level (not per
    // session), so they survive pruneOldSessions below and let us tell
    // "never had a working connection" (nothing to warn about — the token
    // may just not be configured yet, or api_url may be stale) apart from
    // "had one and it broke".
    if (ok) {
      state.everConnected = true;
      if (state.connection && state.connection.broken) delete state.connection;
    } else if (statusCode === 401 || statusCode === 403) {
      if (!state.connection || !state.connection.broken) {
        state.connection = { broken: true, since: new Date().toISOString(), code: statusCode };
      }
    }

    // usage_limit_hit dedup: the flag files that gate re-detection in
    // stop_failure/usage_limit_check/session_update (both the per-session one
    // in os.tmpdir() and the per-account one in FYSO_DIR) are written here,
    // and only on success — mirrors the token-delta marker and everConnected
    // above. Writing them at detection time (the old behavior) meant a
    // failed POST — timeout, 401, fyso being flaky — still suppressed
    // re-detection for 5h with nothing actually delivered; now a failure
    // leaves both files untouched, so the very next Stop/prompt tries again.
    if (ok && raw.event === 'usage_limit_hit') {
      if (sid) {
        try { fs.writeFileSync(path.join(os.tmpdir(), `fyso-limit-hit-${sid}`), ''); } catch (e) {}
      }
      try {
        fs.writeFileSync(path.join(FYSO_DIR, `last-limit-hit-${accountFlagKey(claudeAccount)}`), '');
      } catch (e) {}
    }

    pruneOldSessions(state.sessions);
    writeJsonAtomic(SESSION_STATE_PATH, state);
  });
}

// ─── Per-account scoping for the usage-limit global flag ─────────────────────
// The global `last-limit-hit` flag used to be one file per machine, so
// hitting a limit on one Claude account and switching to another (exactly
// what someone does to work around the limit) meant the second account's hit
// wasn't recorded for up to 5h — silently erasing the evidence of *why* they
// switched, which matters now that telemetry classifies usage in/out of plan
// per account.
//
// `accountFlagKey` hashes the resolved email — the stable identity — never
// `computeCredentialsFingerprint()`, which intentionally changes on every
// OAuth token refresh (that's its whole purpose, cache invalidation) and
// would turn "per account" into "per token refresh", re-triggering reports
// for the *same* still-active limit far more often than intended.
//
// `currentAccountKey` (used only in the foreground gate, where resolving the
// account for real means shelling out to `claude auth status` and risking the
// hook's timeout) reads the last cached email instead — a cheap, sync, local
// file read. That cache is refreshed by resolveClaudeAccount on the next
// background send after any credentials change (fingerprint mismatch, not
// just forceRefresh), so in practice it catches up within one event of an
// account switch. The one edge case it can miss is a limit hit on the very
// first prompt right after switching, before anything else has run in the
// background to refresh the cache — accepted as a narrow, self-correcting
// gap rather than adding a slow subprocess call to the foreground hot path.
function accountFlagKey(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return 'unknown';
  return crypto.createHash('sha256').update(e).digest('hex').slice(0, 16);
}

function currentAccountKey() {
  const cache = readJsonSafe(CLAUDE_ACCOUNT_CACHE_PATH, {});
  return accountFlagKey(cache && cache.email);
}

// ─── Claude account (cached by a fingerprint of ~/.claude/.credentials.json) ──
function computeCredentialsFingerprint() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const oauth = parsed && parsed.claudeAiOauth;
    if (!oauth) return null;
    // accessToken/refreshToken/expiresAt/subscriptionType — no email in this
    // block, which is why the `claude auth status` subprocess is still
    // needed at all; we just avoid launching it when none of these changed.
    const material = JSON.stringify({
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
    });
    return crypto.createHash('sha256').update(material).digest('hex');
  } catch (e) {
    // Missing/unreadable file — e.g. macOS, where Claude Code keeps OAuth
    // credentials in the system Keychain and only falls back to this
    // plaintext file if it exists. Caller falls back to a short-TTL cache.
    return null;
  }
}

async function resolveClaudeAccount({ forceRefresh }) {
  const fingerprint = computeCredentialsFingerprint();
  const cache = readJsonSafe(CLAUDE_ACCOUNT_CACHE_PATH, {});

  if (!forceRefresh && cache.email !== undefined) {
    if (fingerprint !== null && cache.fingerprint === fingerprint) {
      return cache.email || '';
    }
    if (fingerprint === null && cache.cachedAt
      && (Date.now() - Date.parse(cache.cachedAt)) < ACCOUNT_CACHE_FALLBACK_TTL_MS) {
      return cache.email || '';
    }
  }

  const email = launchClaudeAuthStatus();
  try {
    writeJsonAtomic(CLAUDE_ACCOUNT_CACHE_PATH, {
      fingerprint,
      email,
      cachedAt: new Date().toISOString(),
    });
  } catch (e) {}
  return email;
}

function launchClaudeAuthStatus() {
  try {
    const r = spawnSync('claude', ['auth', 'status', '--json'], { shell: true, timeout: 3000 });
    if (r.status === 0 && r.stdout) {
      return JSON.parse(r.stdout.toString()).email || '';
    }
  } catch (e) {}
  return '';
}

// ─── repo (git remote, normalized, cached per directory) ─────────────────────
function resolveRepo(cwd) {
  if (!cwd) return '';
  const cache = readJsonSafe(REPO_CACHE_PATH, {});
  const entry = cache[cwd];
  if (entry && entry.cachedAt && (Date.now() - Date.parse(entry.cachedAt)) < REPO_CACHE_TTL_MS) {
    return entry.remote || '';
  }

  let remote = '';
  try {
    const out = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    remote = normalizeRepoUrl(out.toString().trim());
  } catch (e) {
    remote = '';
  }

  cache[cwd] = { remote, cachedAt: new Date().toISOString() };
  try { writeJsonAtomic(REPO_CACHE_PATH, cache); } catch (e) {}
  return remote;
}

function normalizeRepoUrl(url) {
  if (!url) return '';
  let u = url.trim();
  if (u.endsWith('.git')) u = u.slice(0, -4);
  const sshMatch = u.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`.replace(/^\/+/, '').toLowerCase();
  try {
    const parsed = new URL(u);
    return `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  } catch (e) {
    return u.toLowerCase();
  }
}

function resolvePluginVersion() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return p.version || '';
  } catch (e) { return ''; }
}

// ─── Transcript scanning (session token totals + optional recent-activity detail) ──
function scanTranscript(transcriptPath, opts) {
  const detailWindow = (opts && opts.detailWindow) || 50;
  const collectDetail = !!(opts && opts.collectDetail);
  const result = {
    model: '',
    totals: { total: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    lastText: '',
    toolsUsed: [],
  };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return result;

  let lines = [];
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch (e) { return result; }

  const seenHashes = new Map();
  const recentStart = Math.max(0, lines.length - detailWindow);

  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
    const msg = entry.message || {};
    if (typeof msg !== 'object') continue;
    if (msg.model) result.model = msg.model;

    const u = msg.usage || {};
    const si = u.input_tokens || 0;
    const so = u.output_tokens || 0;
    const scw = u.cache_creation_input_tokens || 0;
    const scr = u.cache_read_input_tokens || 0;
    if (si || so || scw || scr) {
      const msgId = msg.id || '';
      const reqId = entry.requestId || '';
      const hashKey = msgId && reqId ? `${msgId}:${reqId}` : '';
      if (hashKey && seenHashes.has(hashKey)) {
        const p = seenHashes.get(hashKey);
        result.totals.input -= p[0]; result.totals.output -= p[1];
        result.totals.cacheCreation -= p[2]; result.totals.cacheRead -= p[3];
      }
      if (hashKey) seenHashes.set(hashKey, [si, so, scw, scr]);
      result.totals.input += si; result.totals.output += so;
      result.totals.cacheCreation += scw; result.totals.cacheRead += scr;
    }

    if (collectDetail && i >= recentStart) {
      const content = msg.content || [];
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_use' && c.name && !result.toolsUsed.slice(-5).includes(c.name)) {
            result.toolsUsed.push(c.name);
          }
          if (c && c.type === 'text' && msg.role === 'assistant' && (c.text || '').trim().length > 5) {
            result.lastText = c.text.trim();
          }
        }
      }
    }
  }

  result.totals.total = result.totals.input + result.totals.output
    + result.totals.cacheCreation + result.totals.cacheRead;
  return result;
}

// Reads the last `maxBytes` of a file and returns it split into non-empty
// lines, dropping the first line when the file was truncated (it's likely a
// partial JSON line). Throws if the file is missing/unreadable — callers
// catch, same contract as the rest of this section's transcript readers.
function readTailLines(filePath, maxBytes) {
  const size = fs.statSync(filePath).size;
  const readSize = Math.min(size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(readSize);
  fs.readSync(fd, buf, 0, readSize, size - readSize);
  fs.closeSync(fd);
  let text = buf.toString('utf8');
  if (size > maxBytes) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : text;
  }
  return text.split('\n').filter(Boolean);
}

// Returns the last `message.model` seen in a subagent's own transcript, or
// '' if it's missing, unreadable, or its tail holds no model at all (e.g. the
// window landed entirely inside one huge tool_result with no assistant
// message boundary). A subagent runs on one model for its whole transcript,
// so unlike scanTranscript (which scans the full file for running token
// totals) this only needs *a* model line, not all of them — reading just the
// tail avoids parsing what can be multi-MB subagent transcripts inside the
// hook's own ~5s foreground budget. Measured against real transcripts on
// this machine: a 12.4MB file took ~100ms to read in full vs ~0.1ms for the
// last 20KB.
function resolveSubagentModel(agentTranscriptPath) {
  if (!agentTranscriptPath) return '';
  let lines;
  try {
    lines = readTailLines(agentTranscriptPath, TRANSCRIPT_TAIL_READ_BYTES);
  } catch (e) { return ''; }

  let model = '';
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msg = entry.message;
      if (msg && typeof msg === 'object' && msg.model) model = msg.model;
    } catch (e) {}
  }
  return model;
}

function buildActivityDetail(scan) {
  const parts = [];
  if (scan.toolsUsed.length) parts.push(scan.toolsUsed.slice(-5).join(', '));
  if (scan.lastText) parts.push(scan.lastText.split('\n')[0].slice(0, 80));
  const detail = parts.join(' | ') || 'idle';
  return detail.length > 200 ? detail.slice(0, 200) : detail;
}

function buildSummaryDetail(scan) {
  if (scan.lastText) return scan.lastText.split('\n')[0].slice(0, 120);
  if (scan.toolsUsed.length) return `Used: ${scan.toolsUsed.slice(-5).join(', ')}`;
  return 'session update';
}

function detectUsageLimit(transcriptPath, keywords) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { hit: false };
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-50)) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || {};
        if (msg.model !== '<synthetic>') continue;
        const content = msg.content || [];
        const txt = Array.isArray(content)
          ? content.filter((c) => c.type === 'text').map((c) => c.text || '').join(' ')
          : String(content || '');
        const txtLow = txt.toLowerCase();
        if (keywords.some((kw) => txtLow.includes(kw))) {
          const m = txt.match(/resets\s+(\d+(?::\d+)?(?:am|pm))\s+\(([^)]+)\)/i);
          return { hit: true, resetAt: m ? `${m[1]} (${m[2]})` : undefined };
        }
      } catch (e) {}
    }
  } catch (e) {}
  return { hit: false };
}

// ─── Small generic helpers ────────────────────────────────────────────────────
function ensureFysoDir() {
  try { fs.mkdirSync(FYSO_DIR, { recursive: true }); } catch (e) {}
}

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!cfg || !cfg.token || !cfg.api_url) return null;
    return cfg;
  } catch (e) { return null; }
}

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) { return fallback; }
}

function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, filePath);
}

function pruneOldSessions(sessions) {
  const cutoff = Date.now() - SESSION_PRUNE_MS;
  for (const sid of Object.keys(sessions)) {
    const s = sessions[sid];
    const ts = s && s.updatedAt ? Date.parse(s.updatedAt) : 0;
    if (!ts || ts < cutoff) delete sessions[sid];
  }
}

// Cross-platform mutual exclusion via exclusive file creation (O_CREAT|O_EXCL),
// with stale-lock takeover in case a previous process crashed mid-critical-
// section. Only ever used from detached background processes — never on the
// hook's own foreground path — so waiting on it never eats into a hook's
// timeout budget.
async function withFileLock(lockPath, fn) {
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch (e2) {}
          continue;
        }
      } catch (e3) {}
      await sleep(30 + Math.random() * 40);
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch (e) {}
  }
}

function ageHours(filePath) {
  try { return (Date.now() - fs.statSync(filePath).mtimeMs) / 3600000; } catch (e) { return Infinity; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function isDebugEnabled() {
  return fs.existsSync(DEBUG_FLAG_PATH);
}

function rotateDebugLogIfNeeded() {
  try {
    const st = fs.statSync(DEBUG_LOG_PATH);
    if (st.size > MAX_DEBUG_LOG_BYTES) {
      const oldPath = `${DEBUG_LOG_PATH}.old`;
      try { fs.unlinkSync(oldPath); } catch (e) {}
      fs.renameSync(DEBUG_LOG_PATH, oldPath);
    }
  } catch (e) {}
}

function dbg(label, msg) {
  if (!isDebugEnabled()) return;
  rotateDebugLogIfNeeded();
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${label}: ${msg}\n`);
  } catch (e) {}
}

function postJson(urlStr, data, headers) {
  return httpRequest('POST', urlStr, JSON.stringify(data), headers);
}

function httpRequest(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = lib.request(opts, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
