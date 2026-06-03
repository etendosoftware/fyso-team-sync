#!/usr/bin/env node
// fyso-team-sync — Cross-platform hook dispatcher v1.0
// Unix: delegates to bash scripts unchanged (zero behavior change).
// Windows: runs tracking logic natively in Node.js.
'use strict';

const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const crypto = require('crypto');
const { spawnSync, spawn, execFileSync } = require('child_process');
const https = require('https');
const http  = require('http');

const EVENT_TYPE = process.argv[2] || 'session';
const HOOKS_DIR  = __dirname;
const IS_WINDOWS = process.env.FYSO_FORCE_WINDOWS === '1' || process.platform === 'win32';

// Read all stdin synchronously — fd 0 works cross-platform in Node
let stdinData = '';
try { stdinData = fs.readFileSync(0, 'utf8').trim(); } catch (e) {}

// ─── Unix path: delegate to bash scripts, identical behaviour ─────────────────
if (!IS_WINDOWS) {
  if (EVENT_TYPE === 'heartbeat_launch') {
    // Write stdin to temp file, spawn heartbeat.sh detached (mirrors original nohup logic)
    const tmpf = path.join(os.tmpdir(), `fyso-hb-${Date.now()}.json`);
    try { fs.writeFileSync(tmpf, stdinData || '{}'); } catch (e) {}
    const child = spawn('bash', [path.join(HOOKS_DIR, 'heartbeat.sh'), tmpf], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    process.exit(0);
  }

  if (EVENT_TYPE === 'heartbeat_kill') {
    spawnSync('bash', ['-c', "kill $(cat ~/.fyso/heartbeat.pid 2>/dev/null) 2>/dev/null; true"], {
      stdio: 'inherit',
    });
    process.exit(0);
  }

  if (EVENT_TYPE === 'team_update_check') {
    const r = spawnSync('bash', [path.join(HOOKS_DIR, 'check-team-updates.sh')], {
      input: stdinData, stdio: ['pipe', 'inherit', 'inherit'],
    });
    process.exit(r.status || 0);
  }

  // All tracking events → tracking.sh
  const r = spawnSync('bash', [path.join(HOOKS_DIR, 'tracking.sh'), EVENT_TYPE], {
    input: stdinData, stdio: ['pipe', 'inherit', 'inherit'],
  });
  process.exit(r.status || 0);
}

// ─── Windows: heartbeat loop (runs as detached child, launched by heartbeat_launch) ───
if (EVENT_TYPE === 'heartbeat_run') {
  const dataFile = process.argv[3] || '';
  let sessionData = {};
  try { sessionData = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) {}
  try { fs.unlinkSync(dataFile); } catch (e) {}

  const sessionId    = sessionData.session_id    || '';
  const transcriptPath = sessionData.transcript_path || '';
  const cwd          = sessionData.cwd            || '';
  if (!sessionId || !transcriptPath) process.exit(0);

  const configPath = path.join(os.homedir(), '.fyso', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { process.exit(0); }
  const { token, tenant_id: tenant, api_url: apiUrl = 'https://api.fyso.dev', user_email: userEmail = '' } = cfg;
  if (!token || !tenant) process.exit(0);

  const pidFile = path.join(os.homedir(), '.fyso', 'heartbeat-win.pid');
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch (e) {}

  function sendHeartbeat() {
    if (!fs.existsSync(transcriptPath)) return false;

    let lines = [];
    try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean); } catch (e) { return true; }

    let model = '', totalInput = 0, totalOutput = 0, totalCC = 0, totalCR = 0;
    const toolsUsed = [];
    let lastText = '';
    const recentStart = Math.max(0, lines.length - 50);

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg   = entry.message || {};
        if (msg.model) model = msg.model;
        const u = msg.usage || {};
        totalInput  += (u.input_tokens || 0);
        totalOutput += (u.output_tokens || 0);
        totalCC     += (u.cache_creation_input_tokens || 0);
        totalCR     += (u.cache_read_input_tokens || 0);
        if (i >= recentStart) {
          const content = msg.content || [];
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'tool_use' && c.name && !toolsUsed.slice(-3).includes(c.name))
                toolsUsed.push(c.name);
              if (c.type === 'text' && msg.role === 'assistant' && (c.text || '').length > 5)
                lastText = c.text.slice(0, 100);
            }
          }
        }
      } catch (e) {}
    }

    const parts = [];
    if (toolsUsed.length) parts.push(toolsUsed.slice(-5).join(', '));
    if (lastText) parts.push(lastText.split('\n')[0].slice(0, 80));
    const detail      = (parts.join(' | ') || 'idle').slice(0, 200);
    const totalTokens = totalInput + totalOutput + totalCC + totalCR;

    const claudeAccount = getClaudeAccount();

    let teamName = '';
    try {
      const tp = path.join(cwd, '.fyso', 'team.json');
      if (fs.existsSync(tp)) teamName = JSON.parse(fs.readFileSync(tp, 'utf8')).team_name || '';
    } catch (e) {}

    const mf = modelFamily(model);
    const payload = clean({
      event: 'heartbeat', detail,
      team_name:      teamName    || undefined,
      user:           userEmail   || os.userInfo().username,
      claude_account: claudeAccount || undefined,
      session_id:     sessionId   || undefined,
      model:          model       || undefined,
      model_family:   mf          || undefined,
      tokens:         totalTokens || undefined,
      input_tokens:   totalInput  || undefined,
      output_tokens:  totalOutput || undefined,
      cache_creation_tokens: totalCC || undefined,
      cache_read_tokens:     totalCR || undefined,
      cwd: cwd || undefined,
      timestamp: new Date().toISOString(),
    });

    postJson(`${apiUrl}/api/entities/tracking/records`, payload, { 'Authorization': `Bearer ${token}`, 'X-Tenant-ID': tenant })
      .catch(() => {});
    return true;
  }

  function loop() {
    setTimeout(() => {
      if (sendHeartbeat()) loop();
      else { try { fs.unlinkSync(pidFile); } catch (e) {} process.exit(0); }
    }, 5 * 60 * 1000);
  }
  loop(); // keeps event loop alive via timer — no process.exit() here
  return; // don't fall through
}

// ─── Windows: tracking main ───────────────────────────────────────────────────
async function main() {
  const configPath = path.join(os.homedir(), '.fyso', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { return; }

  const { token, tenant_id: tenant, api_url: apiUrl = 'https://api.fyso.dev', user_email: userEmail = '' } = cfg;
  if (!token || !tenant) return;

  const debugPath = path.join(os.homedir(), '.fyso', 'debug');
  const isDebug   = fs.existsSync(debugPath);
  const debugLog  = path.join(os.homedir(), '.fyso', 'hook-debug.log');
  function dbg(msg) {
    if (!isDebug) return;
    try { fs.appendFileSync(debugLog, `[WIN ${new Date().toISOString()}] ${EVENT_TYPE}: ${msg}\n`); } catch (e) {}
  }

  let hook = {};
  try { hook = JSON.parse(stdinData); } catch (e) {}
  if (isDebug) {
    dbg(`stdin_size=${stdinData.length}`);
    try { fs.writeFileSync(path.join(os.homedir(), '.fyso', `last-hook-stdin-${EVENT_TYPE}.json`), stdinData); } catch (e) {}
  }

  // ── heartbeat_launch ───────────────────────────────────────────────────────
  if (EVENT_TYPE === 'heartbeat_launch') {
    const tmpf = path.join(os.tmpdir(), `fyso-hb-${Date.now()}.json`);
    try { fs.writeFileSync(tmpf, stdinData || '{}'); } catch (e) {}
    const child = spawn(process.execPath, [__filename, 'heartbeat_run', tmpf], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    dbg(`heartbeat_run spawned pid=${child.pid}`);
    return;
  }

  // ── heartbeat_kill ─────────────────────────────────────────────────────────
  if (EVENT_TYPE === 'heartbeat_kill') {
    const pidFile = path.join(os.homedir(), '.fyso', 'heartbeat-win.pid');
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
      process.kill(pid);
      fs.unlinkSync(pidFile);
      dbg(`killed heartbeat pid=${pid}`);
    } catch (e) { dbg(`heartbeat_kill: ${e.message}`); }
    return;
  }

  // ── team_update_check ──────────────────────────────────────────────────────
  if (EVENT_TYPE === 'team_update_check') {
    await handleTeamUpdateCheck(cfg, hook, dbg);
    return;
  }

  // ── All tracking events ────────────────────────────────────────────────────
  const toolResponse   = hook.tool_response || {};
  const toolInput      = hook.tool_input    || {};
  const toolName       = hook.tool_name     || '';
  const transcriptPath = hook.transcript_path || '';
  const hookCwd        = hook.cwd || process.cwd();

  // Session ID
  let sessionId = hook.session_id || '';
  if (!sessionId) {
    const key = `${process.ppid}-${new Date().toISOString().split('T')[0]}`;
    sessionId = crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
  }

  // Agent name
  let agent = '';
  if (typeof toolInput === 'object') agent = toolInput.subagent_type || toolInput.name || '';

  // Detail
  let detail = '';
  if (typeof toolInput === 'object') {
    detail = toolInput.description || toolInput.prompt || '';
    if (typeof detail === 'string' && detail.length > 200) detail = detail.slice(0, 200) + '...';
  }
  if (EVENT_TYPE === 'session_start') detail = 'session start';

  // Team name
  let teamName = '';
  try {
    const tp = path.join(hookCwd, '.fyso', 'team.json');
    if (fs.existsSync(tp)) teamName = JSON.parse(fs.readFileSync(tp, 'utf8')).team_name || '';
  } catch (e) {}

  // Per-event tokens
  let inputTokens = 0, outputTokens = 0, cacheCreation = 0, cacheRead = 0;
  let model = '', messageId = '';
  if (typeof toolResponse === 'object') {
    const usage = toolResponse.usage || {};
    inputTokens   = usage.input_tokens || 0;
    outputTokens  = usage.output_tokens || 0;
    cacheCreation = usage.cache_creation_input_tokens || 0;
    cacheRead     = usage.cache_read_input_tokens || 0;
    if (!inputTokens && !outputTokens) outputTokens = toolResponse.totalTokens || 0;
    messageId = toolResponse.id || toolResponse.requestId || '';
  }
  if (!messageId) messageId = hook.requestId || '';
  let tokens = inputTokens + outputTokens + cacheCreation + cacheRead;

  // Session-level token totals (from transcript, deduplicated)
  let sessionInput = 0, sessionOutput = 0, sessionCC = 0, sessionCR = 0, sessionTokens = 0;
  const seenHashes = new Map();
  let lastText = '';
  const toolsUsed = [];

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    if (['session_update', 'session_end'].includes(EVENT_TYPE)) await sleep(1000);
    try {
      const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
      dbg(`transcript: ${lines.length} lines`);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const msg   = entry.message || {};
          if (typeof msg !== 'object') continue;
          if (msg.model) model = msg.model;
          const u  = msg.usage || {};
          const si = u.input_tokens || 0;
          const so = u.output_tokens || 0;
          const scw = u.cache_creation_input_tokens || 0;
          const scr = u.cache_read_input_tokens || 0;
          if (si || so || scw || scr) {
            const hashKey = `${msg.id || ''}:${entry.requestId || ''}`;
            if (hashKey !== ':' && seenHashes.has(hashKey)) {
              const p = seenHashes.get(hashKey);
              sessionInput -= p[0]; sessionOutput -= p[1]; sessionCC -= p[2]; sessionCR -= p[3];
            }
            if (hashKey !== ':') seenHashes.set(hashKey, [si, so, scw, scr]);
            sessionInput += si; sessionOutput += so; sessionCC += scw; sessionCR += scr;
          }
          if (['session_end', 'session_update', 'usage_limit_hit'].includes(EVENT_TYPE)) {
            const content = msg.content || [];
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c.type === 'tool_use' && c.name && !toolsUsed.slice(-5).includes(c.name))
                  toolsUsed.push(c.name);
                if (c.type === 'text' && msg.role === 'assistant' && (c.text || '').length > 10)
                  lastText = c.text;
              }
            }
          }
        } catch (e) {}
      }
      sessionTokens = sessionInput + sessionOutput + sessionCC + sessionCR;
      dbg(`session_tokens=${sessionTokens} model=${model}`);
    } catch (e) { dbg(`transcript error: ${e.message}`); }
  }
  if (!model) model = 'claude-opus-4-6';

  const USAGE_LIMIT_KEYWORDS = [
    'usage limit reached', 'out of extra usage', "you've reached your usage",
    'usage limit', "you're out of", 'limit has been reached', 'no remaining',
    'out of claude', 'monthly usage', 'plan limit', 'tokens remaining',
    'run out of', 'exhausted your', 'quota exceeded', 'quota has been',
  ];

  // ── stop_failure ───────────────────────────────────────────────────────────
  if (EVENT_TYPE === 'stop_failure') {
    const flagFile  = path.join(os.tmpdir(), `fyso-limit-hit-${sessionId}`);
    const globalFlag = path.join(os.homedir(), '.fyso', 'last-limit-hit');
    const sfAge = sessionId && fs.existsSync(flagFile) ? ageHours(flagFile) : Infinity;
    if (sfAge < 5) { dbg(`stop_failure: session flag age=${sfAge.toFixed(1)}h, skip`); return; }
    const gfAge = fs.existsSync(globalFlag) ? ageHours(globalFlag) : Infinity;
    if (gfAge < 5) { dbg(`stop_failure: global flag age=${gfAge.toFixed(1)}h, skip`); return; }
    const lam        = hook.last_assistant_message || '';
    const resetMatch = lam.match(/resets\s+(\d+(?::\d+)?(?:am|pm))\s+\(([^)]+)\)/i);
    const resetAt    = resetMatch ? `${resetMatch[1]} (${resetMatch[2]})` : undefined;
    const errorType  = hook.error_type || '';
    const errorMsg   = hook.error_message || hook.error || '';

    let claudeAccount = getClaudeAccount();
    const mf = modelFamily(model);
    const payload = clean({
      event: 'usage_limit_hit',
      detail: `stop_failure: ${errorType}${errorMsg ? ` - ${String(errorMsg).slice(0, 100)}` : ''}`,
      limit_reset_at: resetAt,
      user: userEmail || os.userInfo().username,
      session_id: sessionId || undefined, claude_account: claudeAccount || undefined,
      model, model_family: mf,
      tokens: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
      session_tokens: sessionTokens, session_input_tokens: sessionInput,
      session_output_tokens: sessionOutput, session_cache_creation_tokens: sessionCC, session_cache_read_tokens: sessionCR,
      cwd: hookCwd || undefined, timestamp: new Date().toISOString(),
    });
    try { fs.writeFileSync(flagFile, ''); } catch (e) {}
    try { fs.writeFileSync(globalFlag, ''); } catch (e) {}
    dbg(`stop_failure: sending payload user=${payload.user}`);
    try {
      const resp = await postJson(`${apiUrl}/api/entities/tracking/records`, payload, authHeaders(token, tenant));
      dbg(`stop_failure: sent OK ${resp.status}`);
    } catch (e) { dbg(`stop_failure: error ${e.message}`); }
    return;
  }

  // ── usage_limit_check ──────────────────────────────────────────────────────
  if (EVENT_TYPE === 'usage_limit_check') {
    const flagFile   = path.join(os.tmpdir(), `fyso-limit-hit-${sessionId}`);
    const globalFlag = path.join(os.homedir(), '.fyso', 'last-limit-hit');
    const sfAge = sessionId && fs.existsSync(flagFile) ? ageHours(flagFile) : Infinity;
    if (sfAge < 5) { dbg(`limit_check: session flag age=${sfAge.toFixed(1)}h, skip`); return; }
    const gfAge = fs.existsSync(globalFlag) ? ageHours(globalFlag) : Infinity;
    if (gfAge < 5) { dbg(`limit_check: global flag age=${gfAge.toFixed(1)}h, skip`); return; }
    const { hit, resetAt } = detectUsageLimit(transcriptPath, USAGE_LIMIT_KEYWORDS, dbg);
    if (!hit) { dbg('limit_check: no hit'); return; }

    let claudeAccount = getClaudeAccount();
    const mf = modelFamily(model);
    const payload = clean({
      event: 'usage_limit_hit', detail: 'usage limit detected',
      limit_reset_at: resetAt,
      user: userEmail || os.userInfo().username,
      session_id: sessionId || undefined, claude_account: claudeAccount || undefined,
      model, model_family: mf,
      tokens: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
      session_tokens: sessionTokens, session_input_tokens: sessionInput,
      session_output_tokens: sessionOutput, session_cache_creation_tokens: sessionCC, session_cache_read_tokens: sessionCR,
      cwd: hookCwd || undefined, timestamp: new Date().toISOString(),
    });
    try { fs.writeFileSync(flagFile, ''); } catch (e) {}
    try { fs.writeFileSync(globalFlag, ''); } catch (e) {}
    dbg(`limit_check: sending payload user=${payload.user}`);
    try {
      const resp = await postJson(`${apiUrl}/api/entities/tracking/records`, payload, authHeaders(token, tenant));
      dbg(`limit_check: sent OK ${resp.status}`);
    } catch (e) { dbg(`limit_check: error ${e.message}`); }
    return;
  }

  // ── session_update: detect usage limit from transcript ────────────────────
  let actualEvent = EVENT_TYPE;
  if (EVENT_TYPE === 'session_update') {
    const flagFile = path.join(os.tmpdir(), `fyso-limit-hit-${sessionId}`);
    if (!(sessionId && fs.existsSync(flagFile))) {
      const { hit } = detectUsageLimit(transcriptPath, USAGE_LIMIT_KEYWORDS, dbg);
      if (hit) {
        actualEvent = 'usage_limit_hit';
        try { fs.writeFileSync(flagFile, ''); } catch (e) {}
      }
    }
  }

  // ── agent_dispatch: detect rate limit from tool_response ──────────────────
  if (EVENT_TYPE === 'agent_dispatch' && typeof toolResponse === 'object' && toolResponse.type === 'error') {
    const errType = (toolResponse.error || {}).type || '';
    if (errType === 'rate_limit_error')    actualEvent = 'rate_limit_hit';
    else if (errType === 'overloaded_error') actualEvent = 'overloaded_hit';
  }

  // For session events: clear per-event tokens, build summary detail
  if (['session_end', 'session_update', 'usage_limit_hit'].includes(actualEvent)) {
    detail = lastText ? lastText.split('\n')[0].slice(0, 120)
           : toolsUsed.length ? 'Used: ' + toolsUsed.slice(-5).join(', ')
           : 'session update';
    tokens = 0; inputTokens = 0; outputTokens = 0; cacheCreation = 0; cacheRead = 0;
  }

  let claudeAccount = getClaudeAccount();
  const mf = modelFamily(model);

  const payload = clean({
    event:        actualEvent,
    tool:         toolName    || undefined,
    agent:        agent       || undefined,
    detail:       detail      || undefined,
    team_name:    teamName    || undefined,
    user:         userEmail || os.userInfo().username,
    claude_account: claudeAccount || undefined,
    session_id:   sessionId   || undefined,
    model:        model       || undefined,
    model_family: mf          || undefined,
    message_id:   messageId   || undefined,
    tokens, input_tokens: inputTokens, output_tokens: outputTokens,
    cache_creation_tokens: cacheCreation, cache_read_tokens: cacheRead,
    session_tokens: sessionTokens, session_input_tokens: sessionInput,
    session_output_tokens: sessionOutput, session_cache_creation_tokens: sessionCC,
    session_cache_read_tokens: sessionCR,
    cwd: hookCwd || undefined,
    timestamp: new Date().toISOString(),
  });

  if (isDebug) dbg(`PAYLOAD: ${JSON.stringify(payload)}`);

  try {
    const resp = await postJson(`${apiUrl}/api/entities/tracking/records`, payload, authHeaders(token, tenant));
    if (isDebug) dbg(`RESPONSE: ${resp.status} ${resp.body.slice(0, 200)}`);
  } catch (e) { dbg(`ERROR: ${e.message}`); }

  // session_start: launch background check for unreported prev-session usage limits
  if (EVENT_TYPE === 'session_start') {
    const script = [
      path.join(HOOKS_DIR, 'check-prev-limit.py'),
      path.join(os.homedir(), '.fyso', 'check-prev-limit.py'),
    ].find(s => fs.existsSync(s));
    const transcriptDir = transcriptPath ? path.dirname(transcriptPath) : '';
    if (script && transcriptDir && fs.existsSync(transcriptDir)) {
      const bgFile = path.join(os.tmpdir(), `fyso-bg-check-${sessionId}.json`);
      try {
        fs.writeFileSync(bgFile, JSON.stringify({
          transcript_dir: transcriptDir, session_id: sessionId,
          api_url: apiUrl, token, tenant, user_email: userEmail, cwd: hookCwd,
        }));
        // shell:false + argv: handles paths with spaces on all platforms
        spawn('python3', [
          '-c', 'import json,sys,os;P=json.load(open(sys.argv[1]));exec(open(sys.argv[2]).read())',
          bgFile, script,
        ], { detached: true, stdio: 'ignore', shell: false }).unref();
      } catch (e) { dbg(`check-prev-limit spawn: ${e.message}`); }
    }
  }
}

// ─── Team update check (Windows) ─────────────────────────────────────────────
async function handleTeamUpdateCheck(cfg, hook, dbg) {
  const { token, tenant_id: tenant, api_url: apiUrl = 'https://api.fyso.dev' } = cfg;
  if (!token || !tenant) return;

  const sessionId = hook.session_id || '';
  const flagFile  = path.join(os.tmpdir(),
    sessionId ? `fyso-version-check-${sessionId}` : `fyso-version-check-${process.ppid}`);
  if (fs.existsSync(flagFile)) return;
  try { fs.writeFileSync(flagFile, ''); } catch (e) {}

  // Traverse up from cwd to find .fyso/team.json
  const startDir = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();
  let dir = startDir, teamFile = null;
  while (dir && dir !== path.dirname(dir)) {
    const candidate = path.join(dir, '.fyso', 'team.json');
    if (fs.existsSync(candidate)) { teamFile = candidate; break; }
    dir = path.dirname(dir);
  }
  if (!teamFile) return;

  let team = {};
  try { team = JSON.parse(fs.readFileSync(teamFile, 'utf8')); } catch (e) { return; }
  const { team_id: teamId, team_name: teamName, version: localVersion = 0 } = team;
  if (!teamId) return;

  try {
    const resp = await httpRequest('GET', `${apiUrl}/api/entities/teams/records/${teamId}`, null,
      authHeaders(token, tenant));
    const data = JSON.parse(resp.body);
    const remoteVersion = parseInt((data.data || data).version || localVersion);
    if (remoteVersion > parseInt(localVersion)) {
      process.stdout.write(
        `[fyso-team-sync] Hay una nueva versión del equipo "${teamName}" disponible ` +
        `(local: v${localVersion}, remota: v${remoteVersion}). ` +
        `IMPORTANTE: antes de responder al usuario, avisale en una línea que hay una actualización ` +
        `disponible y que puede correr /sync-team para actualizar los agentes locales.\n`
      );
    }
  } catch (e) { dbg(`team_update_check: ${e.message}`); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function detectUsageLimit(transcriptPath, keywords, dbg) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { hit: false };
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-50)) {
      try {
        const entry = JSON.parse(line);
        const msg   = entry.message || {};
        if (msg.model !== '<synthetic>') continue;
        const content = msg.content || [];
        const txt = (Array.isArray(content)
          ? content.filter(c => c.type === 'text').map(c => c.text || '').join(' ')
          : String(content || ''));
        const txtLow = txt.toLowerCase();
        if (keywords.some(kw => txtLow.includes(kw))) {
          const m = txt.match(/resets\s+(\d+(?::\d+)?(?:am|pm))\s+\(([^)]+)\)/i);
          return { hit: true, resetAt: m ? `${m[1]} (${m[2]})` : undefined };
        }
      } catch (e) {}
    }
  } catch (e) { if (dbg) dbg(`detectUsageLimit error: ${e.message}`); }
  return { hit: false };
}

function getClaudeAccount() {
  try {
    const r = spawnSync('claude', ['auth', 'status', '--json'], { shell: true, timeout: 3000 });
    if (r.status === 0) return JSON.parse(r.stdout.toString()).email || '';
  } catch (e) {}
  return '';
}

function modelFamily(model) {
  return model.includes('opus')   ? 'opus'
       : model.includes('sonnet') ? 'sonnet'
       : model.includes('haiku')  ? 'haiku'
       : 'opus';
}

function authHeaders(token, tenant) {
  return { 'Authorization': `Bearer ${token}`, 'X-Tenant-ID': tenant };
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function ageHours(filePath) {
  try { return (Date.now() - fs.statSync(filePath).mtimeMs) / 3600000; } catch (e) { return Infinity; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function postJson(urlStr, data, headers) {
  return httpRequest('POST', urlStr, JSON.stringify(data), headers);
}

function httpRequest(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  {
        ...headers,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = lib.request(opts, res => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────
main().catch(() => {}).finally(() => process.exit(0));
