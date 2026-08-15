// Hermes Office — INTERACTIVE agent-activity + projects console (v2)
//
// Builds on @vgalletti/hermes-office (OfficeEventStore + sessionToAgent) and adds:
//   1. Click any agent -> live detail panel (messages read from SQLite, read-only)
//   2. Search + activity filter bar
//   3. Projects panel: GitHub repos (gh) + Vercel projects (vercel) pulled live
//   4. Per-project actions: Inspect (read-only) / Improve / Finish
//      - Improve/Finish spawn a background `hermes chat -q` agent on a branch.
//        Per desktop-operator guardrail: NEVER force-push / commit to main / delete
//        without approval. The agent works on a branch and reports back.
//
// All GitHub/Vercel calls are read-only except the explicit Improve/Finish action,
// which the user must approve twice (button + confirm dialog) before spawning.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { OfficeEventStore, sessionToAgent } from '@vgalletti/hermes-office';

const POLL_MS = 5000;
const STALE_H = 2;
const DB_PATH = `${process.env.LOCALAPPDATA}/hermes/profiles/cipher/state.db`;

// ---------- Database layer: local SQLite (default) OR hosted Postgres ----------
// LOCAL: reads the live session store directly (read-only). This is the default
//   and what runs on your machine at http://127.0.0.1:4173.
// HOSTED: when DATABASE_URL is set (Railway/Render/VPS), reads from a hosted
//   Postgres that a local `sync_to_db.mjs` keeps in sync with your machine.
//   Same UI/endpoints either way. See README "Deploying" for the full setup.
const USE_PG = !!process.env.DATABASE_URL;
let pgPool = null;
if (USE_PG) {
  const { Pool } = await import('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  console.log('[db] using hosted Postgres (DATABASE_URL set)');
}

// ---------- H: safety hardening — audit log + guardrail enforcement ----------
const AUDIT_DIR = `${process.env.LOCALAPPDATA}/hermes-office`;
const AUDIT_FILE = `${AUDIT_DIR}/audit.log`;
try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}
// H1/H2: every action (inspect/improve/finish/repair scan) is appended to an
// append-only audit log with timestamp + outcome. Survives restarts.
function audit(kind, detail, ok) {
  const line = `${new Date().toISOString()} | ${ok ? 'OK ' : 'NO '} | ${kind} | ${detail}\n`;
  try { appendFileSync(AUDIT_FILE, line); } catch {}
  pushEvent('system', 'audit', `audit: ${kind} ${ok ? 'ok' : 'blocked'}`);
}
// H3/H4: explicit guardrail enforcement. The desktop-operator rules:
//   - NEVER commit/push to main, NEVER force-push, NEVER delete pre-existing files
//   - proposal-only for repairs: we surface findings, user approves before any edit.
// These are re-stated in every spawned agent prompt AND checked here so a stray
// request can't slip through. Returns {allowed:boolean, reason:string}.
function enforceGuardrails(repo, action) {
  if (/^(main|master)$/i.test(repo)) return { allowed: false, reason: 'guardrail: will not touch main/master branch' };
  if (/\b(force|delete|rm|remove|git clean)\b/i.test(action || ''))
    return { allowed: false, reason: 'guardrail: force/delete/rm not permitted' };
  return { allowed: true, reason: 'ok' };
}
const GUARDRAIL_CLAUSE =
  ' GUARDRAILS (mandatory): never commit or push to main/master, never force-push, ' +
  'never delete or overwrite pre-existing files, never run git clean. ' +
  'Propose changes on a branch and open a PR; wait for human approval before any destructive step.';

// ---------- open live store (read-only) ----------
// LOCAL: open the machine's SQLite session store read-only. Skipped when using Postgres.
let db;
if (!USE_PG) {
  try {
    db = new DatabaseSync(DB_PATH);
    db.exec('pragma query_only = on;');
  } catch (e) {
    console.error(`Cannot open live session store at ${DB_PATH}\n${e.message}`);
    process.exit(1);
  }
}

const COLS = `id, title, source, model, message_count, tool_call_count,
  last_activity_at, last_activity_description, end_reason, pinned, git_repo_root, started_at`;

function rowToAgent(r) {
  // Coerce: Postgres returns BIGINT/INTEGER as strings; SQLite as numbers.
  const num = (v) => (v === null || v === undefined ? v : Number(v));
  const lastActive = num(r.last_activity_at) ?? num(r.started_at) ?? 0;
  const base = sessionToAgent({
    id: r.id, title: r.title, source: r.source, model: r.model,
    last_active: lastActive, end_reason: r.end_reason,
  });
  const open = !r.end_reason;
  let activity = 'idle';
  if (open) {
    const d = (r.last_activity_description || '').toLowerCase();
    if (/error|fail|exception/.test(d)) activity = 'error';
    else if (/writ|edit|patch|creat|file/.test(d)) activity = 'writing';
    else if (/read|search|fetch|brows|scan/.test(d)) activity = 'reading';
    else if (/wait|await|approv|input|stream/.test(d)) activity = 'waiting';
    else activity = 'thinking';
  }
  return {
    ...base, activity, open,
    model: r.model || base.model,
    source: r.source || base.source,
    activityDetail: r.last_activity_description || (open ? 'active' : 'ended'),
    messageCount: num(r.message_count) ?? 0,
    toolCalls: num(r.tool_call_count) ?? 0,
    pinned: !!r.pinned,
    startedAt: num(r.started_at) ? new Date(num(r.started_at) * 1000).toISOString() : undefined,
    gitRepoRoot: r.git_repo_root || undefined,
  };
}

// A6: SSE payload = summaries only (drop verbose activityDetail; full agent with
// messages lives behind /messages). Keeps /stream small under 566 agents.
function toSummary(a) {
  const { activityDetail, gitRepoRoot, ...rest } = a;
  return rest;
}

// C4: server-side KPIs from the SAME snapshot the SSE uses (single source of truth).
function computeKpi(agents) {
  let active = 0, thinking = 0, errors = 0, abandoned = 0, ended = 0;
  for (const a of agents) {
    if (!a.open) { ended++; continue; }
    const ageH = (() => { const iso = a.lastActiveAt || a.startedAt; if (!iso) return 1e9; return (Date.now() - new Date(iso).getTime()) / 3.6e6; })();
    if (ageH > STALE_H) abandoned++;
    else active++;
    if (a.activity === 'thinking') thinking++;
    if (a.activity === 'error') errors++;
  }
  return { active, thinking, errors, abandoned, ended, total: agents.length, tasks: tickets.length, projects: 0 };
}

async function loadLive() {
  if (USE_PG) {
    const r = await pgPool.query(`select ${COLS} from sessions`);
    return r.rows.map(rowToAgent);
  }
  return db.prepare(`select ${COLS} from sessions order by last_activity_at desc`).all().map(rowToAgent);
}

const store = new OfficeEventStore([]);
(async () => {
  try { store.apply({ type: 'snapshot', agents: await loadLive() }); } catch (e) { console.error('initial load failed:', e.message); }
  setInterval(async () => { try { store.apply({ type: 'snapshot', agents: await loadLive() }); } catch (e) {} }, POLL_MS);
})();

// GROUP E — activity timeline (E1/E2/E4): in-memory event buffer, diff consecutive
// snapshots to emit ONLY real status transitions (no spam every poll).
const EVENT_BUF = [];
const EVENT_MAX = 100;
let prevSig = new Map();
function keyOf(a) { return a.id; }
function sigOf(a) { return (a.open ? 'open:' + a.activity : 'ended'); }
function pushEvent(entity, kind, message) {
  const ev = { t: Date.now(), entity, kind, message };
  EVENT_BUF.push(ev);
  while (EVENT_BUF.length > EVENT_MAX) EVENT_BUF.shift();
  // notify any connected timeline SSE clients
  timelineClients.forEach((res) => {
    try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
  });
}
function diffSnapshots(list) {
  const now = new Map(list.map((a) => [keyOf(a), a]));
  // transitions: id existed before with different sig
  for (const a of list) {
    const s = sigOf(a);
    const prev = prevSig.get(a.id);
    if (prev !== undefined && prev !== s) {
      const label = a.open ? `→ ${a.activity}` : '→ ended';
      pushEvent(a.id, a.open ? 'status' : 'ended', `agent ${a.id}: ${label}`);
    }
  }
  // agent gate hits (task attempts) handled in handleAction via pushEvent
  prevSig = now;
}
// wrap the poll to diff
setInterval(() => {
  try { diffSnapshots(store.snapshot()); } catch {}
}, POLL_MS);
function emitTaskEvent(repo, action, ok, detail) {
  pushEvent(`task:${repo}`, 'task', `Improve/Finish ${action} on ${repo}: ${ok ? 'started' : 'blocked'} ${detail || ''}`);
}

// ---------- endpoints ----------
const ACTIVITY_META = {
  idle: '#64748b', thinking: '#8b5cf6', writing: '#10b981', reading: '#0ea5e9', waiting: '#f59e0b', error: '#ef4444',
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function send(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// GET /messages?id=...  -> read-only messages for one session
async function messagesFor(id) {
  try {
    if (USE_PG) {
      const r = await pgPool.query(
        `select role, content, tool_name, timestamp from messages where session_id = $1 order by timestamp asc limit 60`,
        [id]
      );
      return r.rows.map((m) => ({
        role: m.role,
        tool: m.tool_name || null,
        at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
        text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
    }
    const rows = db.prepare(
      `select role, content, tool_name, timestamp from messages where session_id = ? order by timestamp asc limit 60`
    ).all(id);
    return rows.map((m) => ({
      role: m.role,
      tool: m.tool_name || null,
      at: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
      text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
  } catch { return []; }
}

// GET /projects -> live GitHub repos + Vercel projects (read-only shell calls)
// A5: cache for 50s so the 566-agent board never waits on gh/vercel; A2: gh and
// vercel are already independently try/caught so one failing can't empty both.
const PROJECTS_TTL = 50000;
let projectsCache = { at: 0, data: null };
async function getProjects() {
  const now = Date.now();
  if (projectsCache.data && now - projectsCache.at < PROJECTS_TTL) {
    return { ...projectsCache.data, cachedAt: projectsCache.at, stale: false };
  }
  const out = { github: [], vercel: [], error: null, cachedAt: now, stale: false };
  try {
    const gh = await run('gh', ['repo', 'list', 'jasonmanuel-cmd', '--limit', '40', '--json', 'name,url,updatedAt,isPrivate,description']);
    out.github = JSON.parse(gh || '[]');
  } catch (e) { out.error = (out.error ? out.error + '; ' : '') + 'gh: ' + e.message; }
  try {
    const v = await run('vercel', ['project', 'ls']);
    out.vercel = parseVercel(v);
  } catch (e) { out.error = (out.error ? out.error + '; ' : '') + 'vercel: ' + e.message; }
  // G1/G2: attach proactive-repair health to each project (from the repair scan,
  // matched by repo name) so the Projects panel shows risk at a glance.
  const byName = {};
  for (const r of REPAIRS) {
    const base = (r.name || '').toLowerCase();
    for (const p of [...out.github, ...out.vercel]) {
      if ((p.name || '').toLowerCase() === base) { (byName[p.name] = byName[p.name] || []).push(...r.issues); }
    }
  }
  for (const p of [...out.github, ...out.vercel]) {
    const issues = byName[p.name] || [];
    p.repairIssues = issues.length;
    p.repairHigh = issues.filter((i) => i.sev === 'high').length;
  }
  // On total failure, fall back to last good cache (with stale:true) so the board
  // survives a Vercel logout / network blip instead of showing empty.
  if (!out.github.length && !out.vercel.length && out.error && projectsCache.data) {
    return { ...projectsCache.data, cachedAt: projectsCache.at, stale: true };
  }
  projectsCache = { at: now, data: out };
  return out;
}

function parseVercel(txt) {
  // `vercel project ls` is fixed-width space-padded (not tab/space-delimited).
  const lines = (txt || '').split('\n').filter(Boolean);
  const rows = [];
  let inTable = false;
  for (const line of lines) {
    if (/Project Name/.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    // stop at the underline row or blank
    if (/^-+$/.test(line.trim())) continue;
    const name = line.slice(1, 35).trim();
    const url = line.slice(35, 90).trim();
    const updated = line.slice(90, 100).trim();
    if (!name) continue;
    rows.push({ name, url: url || null, updated: updated || null });
  }
  return rows;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    // Windows: many CLIs (vercel, hermes) are .cmd shims that don't resolve via
    // raw spawn — go through cmd /c so PATHEXT shims are found.
    const useShell = process.platform === 'win32';
    const p = useShell
      ? spawn('cmd', ['/c', cmd, ...args], { windowsHide: true, timeout: 40000 })
      : spawn(cmd, args, { windowsHide: true, timeout: 40000 });
    let buf = '', err = '', done = false;
    // A3: merge BOTH streams for all commands (vercel writes table to stderr when
    // non-interactive; other CLIs vary too). A4: hard timeout + non-zero exit handling
    // so a hung gh/vercel can't wedge the dashboard process.
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', (d) => { buf += d; err += d; });
    p.on('error', (e) => { if (!done) { done = true; reject(e); } });
    p.on('close', (code, sig) => {
      if (done) return;
      done = true;
      if (code === 0) resolve(buf);
      else if (sig) reject(new Error(`${cmd} killed (${sig})`));
      else reject(new Error(err || `${cmd} exit ${code}`));
    });
  });
}

// background agent task tickets
const tickets = [];
const timelineClients = new Set();
// F4: persist tickets to a small local JSON so restart doesn't wipe them
const TICKET_FILE = `${process.env.LOCALAPPDATA}/hermes/profiles/cipher/skills/hermes-office-live/tickets.json`;
function persistTickets() {
  try { writeFileSync(TICKET_FILE, JSON.stringify(tickets.slice(0, 50))); } catch {}
}
function loadTicketsFile() {
  try { const t = JSON.parse(readFileSync(TICKET_FILE, 'utf8')); if (Array.isArray(t)) t.forEach((x) => tickets.push(x)); } catch {}
}
loadTicketsFile();

// ---------- J: MESSAGE BOARD (Wave 5) ----------
// A single shared message board local agents (or you) can post to — questions,
// results, status. Persisted as JSON so it survives restarts. Free-text composer
// + auto-posts from task results / repair scans. Local-only (same as the board).
const MSG_FILE = `${process.env.LOCALAPPDATA}/hermes-office/messages.json`;
const messageClients = new Set();
let MESSAGES = [];
const MSG_MAX = 200;
function loadMessages() {
  try { const m = JSON.parse(readFileSync(MSG_FILE, 'utf8')); if (Array.isArray(m)) MESSAGES = m; } catch {}
}
loadMessages();
function persistMessages() { try { writeFileSync(MSG_FILE, JSON.stringify(MESSAGES.slice(-MSG_MAX))); } catch {} }
// kind: note|result|question|system ; group: free-form tag (auto = repo/project name)
function postMessage(from, text, kind, group) {
  const m = {
    id: 'mb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    from: String(from || 'anon').slice(0, 40),
    text: String(text || '').slice(0, 2000),
    kind: String(kind || 'note').slice(0, 16),
    group: String(group || '').slice(0, 40),
    t: Date.now(),
  };
  if (!m.text) return null;
  MESSAGES.push(m);
  while (MESSAGES.length > MSG_MAX) MESSAGES.shift();
  persistMessages();
  messageClients.forEach((res) => { try { res.write(`data: ${JSON.stringify(m)}\n\n`); } catch {} });
  return m;
}
function groupsList() {
  const s = new Set();
  MESSAGES.forEach((m) => { if (m.group) s.add(m.group); });
  return [...s];
}

// POST /action  { repo, action: 'inspect'|'improve'|'finish', approved: bool }
// ---------- I: PROACTIVE REPAIR SCANNER (code/programs/scripts; NOT websites) ----------
// Continuously scans local code/program/script dirs + self-built artifacts for
// repair opportunities. PROPOSAL-ONLY: findings are surfaced for approval; nothing
// is edited/deleted automatically. Websites are explicitly excluded per directive.
const SCAN_ROOTS = [
  `${process.env.USERPROFILE}/hermes-office`,
  `${process.env.LOCALAPPDATA}/hermes/profiles/cipher/skills`,
  `${process.env.USERPROFILE}/lead-tracking`,
  `${process.env.USERPROFILE}/revenue_agent.py`,
].filter(Boolean)
  // drop blank entries; we scan the 3 code dirs + the revenue script (not the whole home)
  .filter(p => !p.endsWith('\\') && !p.includes('*'));
// Never descend into these (dependencies, VCS, or website projects).
const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  'MASTER-COAI', 'COAI-WEBSITE', 'elite-spa', 'eliteautospa', 'wazshop',
  'coai-agent-one', 'prime-agent', 'prime-agent-ui', 'MASTER-COAI', 'Desktop',
]);
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.bat', '.cmd', '.ps1']);
let REPAIRS = [];          // current findings
let lastScanAt = 0;
let scanRunning = false;

function walkCode(root, depth, out) {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(root); } catch { return; }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (SCAN_EXCLUDE_DIRS.has(name)) continue;
    const full = `${root}/${name}`;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { walkCode(full, depth + 1, out); continue; }
    const ext = name.slice(name.lastIndexOf('.'));
    if (!SCAN_EXT.has(ext)) continue;
    if (st.size > 2_000_000) continue; // skip huge files
    out.push({ root, full, name, ext, size: st.size });
  }
}

// Lightweight, safe static checks (no execution of unknown code).
function checkFile(f) {
  const issues = [];
  let src = '';
  try { src = readFileSync(f.full, 'utf8'); } catch { return issues; }
  // marker hints
  const markers = (src.match(/\b(TODO|FIXME|XXX|HACK|BUG|deprecated)\b/gi) || []);
  if (markers.length) issues.push({ sev: 'low', note: `maintainer markers: ${[...new Set(markers.map(m=>m.toUpperCase()))].join(', ')} (${markers.length})` });
  if (f.size === 0) issues.push({ sev: 'med', note: 'empty (0-byte) file' });
  // syntax check by type — safe arg-array execution (no shell interpolation)
  if (f.ext === '.py') {
    try { execFileSync('python', ['-c', `compile(open(r'${f.full}',encoding='utf-8',errors='ignore').read(),'${f.name}','exec')`], { windowsHide: true, timeout: 8000 }); }
    catch (e) { issues.push({ sev: 'high', note: 'Python syntax error' }); }
  } else if (['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(f.ext)) {
    try { execFileSync('node', ['--check', f.full], { windowsHide: true, timeout: 8000 }); }
    catch (e) { issues.push({ sev: 'high', note: 'JS/TS syntax error' }); }
  }
  return issues;
}

async function runRepairScan() {
  if (scanRunning) return;
  scanRunning = true;
  const found = [];
  try {
    const files = [];
    for (const r of SCAN_ROOTS) walkCode(r, 0, files);
    for (const f of files) {
      const issues = checkFile(f);
      if (issues.length) found.push({ file: f.full, name: f.name, size: f.size, issues });
    }
    REPAIRS = found.slice(0, 200);
    lastScanAt = Date.now();
    pushEvent('system', 'repair-scan', `repair scan: ${files.length} files checked, ${found.length} findings`);
    postMessage('repair-scanner', `Repair scan: ${files.length} files checked, ${found.length} findings`, 'result', 'repairs');
  } catch (e) {
    pushEvent('system', 'repair-scan', `repair scan error: ${e.message}`);
  } finally {
    scanRunning = false;
  }
}
// I1/I2: continuous proactive scan on an interval (every 10 min); kick off the
// first scan shortly AFTER the server starts listening (don't block boot).
setInterval(runRepairScan, 10 * 60 * 1000);
setTimeout(runRepairScan, 1500);
function handleAction(body) {
  const repo = (body.repo || '').toString();
  const action = (body.action || '').toString();
  if (!/^[a-z\-]+$/.test(repo) || !['inspect', 'improve', 'finish'].includes(action))
    return { ok: false, error: 'bad repo/action' };
  // H3/H4: guardrail enforcement before anything happens
  const g = enforceGuardrails(repo, action);
  if (!g.allowed) { audit('action', `${action} ${repo} BLOCKED: ${g.reason}`, false); return { ok: false, error: g.reason }; }
  if (action === 'inspect') {
    emitTaskEvent(repo, 'inspect', true, '(read-only)');
    audit('inspect', repo, true);
    return { ok: true, ticket: 'inspect is read-only — use the Projects panel + "open" links', mode: 'read' };
  }
  // F6: hard cap concurrent Improve/Finish spawns
  const running = tickets.filter((t) => t.status === 'running').length;
  if (running >= 2) {
    emitTaskEvent(repo, action, false, `(cap: ${running}/2 running)`);
    return { ok: false, error: `max 2 concurrent tasks (${running} running) — wait for one to finish` };
  }
  // improve / finish require explicit approval (second gate)
  if (!body.approved) {
    emitTaskEvent(repo, action, false, '(approval pending)');
    return { ok: false, needApproval: true, message: `Approve spawning a background Hermes agent to ${action} ${repo}? It will work on a branch and NOT push to main without your OK.` };
  }
  const verb = action === 'finish' ? 'finish/complete and harden' : 'improve and refactor';
  const prompt = `You are operating on the GitHub repo jasonmanuel-cmd/${repo} (cloned locally or via gh). ${verb} this project: review code, fix bugs, improve structure, and prepare changes on a NEW branch named hermes-office/${action}-${Date.now().toString(36)}. Do NOT commit to main, do NOT force-push, do NOT delete anything.${GUARDRAIL_CLAUSE} When done, open a PR via 'gh pr create' and report a one-line summary. If you cannot safely change something, leave it and note why.`;
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'hermes', 'chat', '-q', prompt, '--profile', 'cipher'], { windowsHide: true, detached: false })
    : spawn('hermes', ['chat', '-q', prompt, '--profile', 'cipher'], { windowsHide: true, detached: false });
  const ticket = { id: 'tk_' + Date.now().toString(36), repo, action, pid: child.pid, startedAt: new Date().toISOString(), status: 'running' };
  tickets.unshift(ticket);
  persistTickets();
  emitTaskEvent(repo, action, true, `(pid ${child.pid})`);
  child.on('exit', (code) => {
    ticket.status = code === 0 ? 'done' : 'exited-' + code;
    persistTickets();
    postMessage('task:' + repo, `Improve/Finish ${action} ${repo}: ${ticket.status}` + (code ? ` (exit ${code})` : ''), 'result', repo);
  });
  return { ok: true, ticket, mode: 'agent' };
}

// ---------- HTTP ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const snap = () => store.snapshot().map(toSummary);
    const writeSnap = () => { try { res.write(`event: snapshot\ndata: ${JSON.stringify({ agents: snap() })}\n\n`); } catch { clearInterval(t); } };
    writeSnap();
    const t = setInterval(writeSnap, POLL_MS);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (url.pathname === '/messages') {
    const id = url.searchParams.get('id') || '';
    return send(res, { id, messages: await messagesFor(id) });
  }
  if (url.pathname === '/projects') {
    return send(res, await getProjects());
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    timelineClients.add(res);
    EVENT_BUF.slice(-30).forEach((ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} });
    req.on('close', () => timelineClients.delete(res));
    return;
  }
  if (url.pathname === '/repairs') {
    return send(res, { scanning: scanRunning, lastScanAt, count: REPAIRS.length, repairs: REPAIRS.slice(0, 100) });
  }
  if (url.pathname === '/audit') {
    let lines = [];
    try { lines = readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-200); } catch {}
    return send(res, { entries: lines });
  }
  // J: message board endpoints
  if (url.pathname === '/messages-board') {
    if (req.method === 'POST') {
      let b = ''; req.on('data', (d) => (b += d));
      req.on('end', () => {
        try {
          const j = JSON.parse(b || '{}');
          const m = postMessage(j.from, j.text, j.kind, j.group);
          if (!m) return send(res, { ok: false, error: 'empty text' });
          audit('message', `${m.from}: ${m.text.slice(0, 60)}`, true);
          send(res, { ok: true, message: m });
        } catch { send(res, { ok: false, error: 'bad json' }); }
      });
      return;
    }
    return send(res, { messages: MESSAGES.slice(-100), groups: groupsList() });
  }
  if (url.pathname === '/msg-groups') {
    return send(res, { groups: groupsList() });
  }
  if (url.pathname === '/messages-stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    messageClients.add(res);
    MESSAGES.slice(-20).forEach((m) => { try { res.write(`data: ${JSON.stringify(m)}\n\n`); } catch {} });
    req.on('close', () => messageClients.delete(res));
    return;
  }
  if (url.pathname === '/rescan' && req.method === 'POST') {
    runRepairScan();
    return send(res, { ok: true, scanning: scanRunning });
  }
  if (url.pathname === '/kpi') {
    const snap = store.snapshot();
    const k = computeKpi(snap);
    k.projects = (projectsCache.data ? (projectsCache.data.github.length + projectsCache.data.vercel.length) : 0);
    return send(res, k);
  }
  if (url.pathname === '/tickets') {
    return send(res, { tickets });
  }
  if (url.pathname === '/action' && req.method === 'POST') {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { try { send(res, handleAction(JSON.parse(b || '{}'))); } catch { send(res, { ok: false, error: 'bad json' }); } });
    return;
  }
  // board
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(boardHtml());
});

function boardHtml() {
  const list = store.snapshot();
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Hermes Office — Live Console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font:14px/1.4 ui-sans-serif,system-ui; background:#0b1020; color:#e5e7eb; margin:0; display:grid; grid-template-columns: 1fr 360px; grid-template-rows: auto 1fr; height:100vh; }
  header { grid-column:1/3; padding:12px 18px; border-bottom:1px solid #1e293b; background:#0b1020; }
  h1 { font-size:18px; margin:0 0 6px; }
  .sub { color:#64748b; font-size:12px; }
  .bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px; }
  .bar input { background:#111a30; border:1px solid #334155; color:#e5e7eb; border-radius:6px; padding:5px 9px; font-size:13px; min-width:200px; }
  .pill { display:inline-block; padding:3px 9px; border-radius:999px; border:1px solid #334155; font-size:12px; cursor:pointer; }
  .pill.on { background:#1e293b; border-color:#475569; color:#fff; }
  .pill.big { font-size:13px; font-weight:600; padding:4px 12px; cursor:default; }
  main { overflow:auto; padding:16px 18px; }
  aside { border-left:1px solid #1e293b; background:#0a0e1c; overflow:auto; padding:14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; }
  .card { background:#111a30; border:1px solid #1e293b; border-left:4px solid var(--accent); border-radius:9px; padding:10px 12px; cursor:pointer; transition:.15s; }
  .card:hover { transform:translateY(-2px); box-shadow:0 6px 18px #0008; }
  .card.sel { outline:2px solid #6366f1; }
  .card.abandoned { filter:grayscale(.7) brightness(.82); border-left-style:dashed; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--accent); box-shadow:0 0 8px var(--accent); display:inline-block; margin-bottom:5px; animation:pulse 1.6s infinite; }
  .card.abandoned .dot { animation:none; opacity:.5; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  .name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .status { color:var(--accent); font-weight:600; font-size:12px; margin:1px 0 5px; }
  .badge { font-size:9px; font-weight:700; color:#fca5a5; border:1px solid #ef4444; border-radius:4px; padding:1px 4px; margin-left:5px; }
  .meta { font-size:11px; color:#94a3b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .meta.dim { color:#64748b; margin-top:3px; }
  /* detail panel */
  .panel h2 { font-size:14px; margin:0 0 8px; }
  .msg { border-bottom:1px solid #131c33; padding:7px 0; }
  .msg .r { font-size:10px; font-weight:700; text-transform:uppercase; color:#64748b; }
  .msg .r.tool { color:#0ea5e9; }
  .msg .t { font-size:12px; color:#cbd5e1; white-space:pre-wrap; word-break:break-word; max-height:160px; overflow:auto; }
  /* projects */
  .sec { margin-bottom:18px; }
  .sec h3 { font-size:13px; color:#94a3b8; border-bottom:1px solid #1e293b; padding-bottom:5px; margin:0 0 8px; }
  .proj { background:#111a30; border:1px solid #1e293b; border-radius:8px; padding:8px 10px; margin-bottom:7px; }
  .proj .pn { font-weight:600; }
  .proj a { color:#818cf8; text-decoration:none; font-size:11px; }
  .proj .acts { margin-top:6px; display:flex; gap:5px; }
  .proj button { background:#1e293b; color:#cbd5e1; border:1px solid #334155; border-radius:6px; padding:3px 8px; font-size:11px; cursor:pointer; }
  .proj button.imp { border-color:#10b98155; }
  .proj button.fin { border-color:#8b5cf655; }
  .tag { font-size:10px; color:#64748b; }
  .rk { border-bottom:1px solid #131c33; padding:6px 0; }
  .rk b { color:#e5e7eb; font-size:12px; }
  #audit .meta.dim { font-size:10px; }
  #repairs .meta.dim { font-size:11px; }
  #status { position:fixed; bottom:8px; right:372px; font-size:11px; color:#475569; background:#0b1020cc; padding:3px 8px; border-radius:6px; }
  .confirm { background:#1e293b; border:1px solid #f59e0b; border-radius:8px; padding:10px; margin-top:8px; font-size:12px; }
  .confirm button { margin-top:6px; }
  /* KPI cards (Group C) */
  .kpi { display:inline-flex; flex-direction:column; padding:6px 12px; border-radius:9px; background:#111a30; border:1px solid #1e293b; border-left:4px solid var(--kc,#475569); cursor:pointer; min-width:78px; transition:.15s; }
  .kpi:hover { transform:translateY(-2px); }
  .kpi .v { font-size:18px; font-weight:700; color:#e5e7eb; }
  .kpi .l { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:#94a3b8; }
  .kpi .d { font-size:10px; }
  .kpi.on { outline:2px solid #6366f1; }
  /* drawer v2 (Group D) */
  #backdrop { position:fixed; inset:0; background:#0009; display:none; z-index:40; }
  #backdrop.open { display:block; }
  #drawer { position:fixed; top:0; right:0; height:100vh; width:440px; max-width:92vw; background:#0a0e1c; border-left:1px solid #1e293b; transform:translateX(100%); transition:transform .22s ease; z-index:50; display:flex; flex-direction:column; }
  #drawer.open { transform:translateX(0); }
  #drawer .dh { padding:12px 14px; border-bottom:1px solid #1e293b; display:flex; justify-content:space-between; align-items:flex-start; }
  #drawer .dtabs { display:flex; gap:4px; padding:8px 14px; border-bottom:1px solid #1e293b; }
  #drawer .dtab { padding:4px 10px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #334155; color:#94a3b8; }
  #drawer .dtab.on { background:#1e293b; color:#fff; }
  #drawer .dbody { padding:10px 14px; overflow:auto; flex:1; }
  #drawer .ov { font-size:12px; color:#cbd5e1; }
  #drawer .ov .row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #131c33; }
  #drawer .ov .k { color:#64748b; }
  #drawer .copy { background:#1e293b; color:#cbd5e1; border:1px solid #334155; border-radius:5px; padding:2px 7px; font-size:11px; cursor:pointer; }
  #drawer .msgsearch { width:100%; background:#111a30; border:1px solid #334155; color:#e5e7eb; border-radius:6px; padding:5px 8px; font-size:12px; margin-bottom:8px; }
  #drawer .msg { border-bottom:1px solid #131c33; padding:7px 0; }
  #drawer .msg .r { font-size:10px; font-weight:700; text-transform:uppercase; color:#64748b; }
  #drawer .msg .r.tool { color:#0ea5e9; }
  #drawer .msg .t { font-size:12px; color:#cbd5e1; white-space:pre-wrap; word-break:break-word; }
  #drawer .tl { font-size:12px; }
  #drawer .tl .ev { padding:5px 0; border-bottom:1px solid #131c33; color:#94a3b8; }
  /* timeline + tasks (Group E/F) */
 .tl .ev:hover { color:#e5e7eb; }
 .tl .ev b { color:#e5e7eb; }
 .tl .ev .ts { color:#475569; font-size:10px; }
 /* tasks board (Group F) */
 .tk { background:#111a30; border:1px solid #1e293b; border-left:4px solid var(--tc,#475569); border-radius:7px; padding:7px 9px; margin-bottom:6px; font-size:11px; }
 .tk .repo { font-weight:600; color:#e5e7eb; }
 .tk .meta2 { color:#94a3b8; margin-top:2px; }
 .tk .dismiss { float:right; cursor:pointer; color:#64748b; font-size:11px; }
 .tk .dismiss:hover { color:#f87171; }
 .tkcols { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
 /* Wave 5 — message board (J) */
 .mb { background:#111a30; border:1px solid #1e293b; border-radius:8px; padding:8px; margin-bottom:7px; }
 .mb .mf { font-size:11px; color:#94a3b8; }
 .mb .mf b { color:#818cf8; }
 .mb .mk { font-size:9px; font-weight:700; text-transform:uppercase; padding:1px 5px; border-radius:4px; border:1px solid #334155; color:#64748b; margin-left:5px; }
 .mb .mk.result { color:#10b981; border-color:#10b98155; }
 .mb .mk.question { color:#f59e0b; border-color:#f59e0b55; }
 .mb .mg { font-size:9px; color:#0ea5e9; border:1px solid #0ea5e955; border-radius:4px; padding:1px 5px; margin-left:4px; }
 .mb .mt { font-size:12px; color:#cbd5e1; white-space:pre-wrap; word-break:break-word; margin-top:3px; }
 .mb .ts { color:#475569; font-size:10px; }
 .composer { display:flex; flex-direction:column; gap:5px; margin-bottom:8px; }
 .composer input, .composer select { background:#111a30; border:1px solid #334155; color:#e5e7eb; border-radius:6px; padding:4px 7px; font-size:12px; }
 .composer textarea { background:#111a30; border:1px solid #334155; color:#e5e7eb; border-radius:6px; padding:5px 7px; font-size:12px; min-height:42px; resize:vertical; }
 .composer button { background:#1e293b; color:#cbd5e1; border:1px solid #334155; border-radius:6px; padding:4px 9px; font-size:12px; cursor:pointer; align-self:flex-start; }
 .mbchips { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:6px; }
 .mbchips .pill { padding:2px 8px; font-size:11px; }
 /* Wave 5 — reconnect button (B) */
 #reconnect { background:#1e293b; color:#cbd5e1; border:1px solid #334155; border-radius:6px; padding:3px 9px; font-size:12px; cursor:pointer; }
 /* Wave 5 — abandoned view (dedicated) */
 #abview { padding:6px 0; }
 #abview .ab { background:#111a30; border:1px solid #1e293b; border-left:4px dashed #ef4444; border-radius:8px; padding:8px 10px; margin-bottom:7px; cursor:pointer; }
 #abview .ab .nm { font-weight:600; }
 #abview .ab .meta2 { font-size:11px; color:#94a3b8; margin-top:2px; }
 #abview .ab .badge { font-size:9px; font-weight:700; color:#fca5a5; border:1px solid #ef4444; border-radius:4px; padding:1px 4px; margin-left:5px; }

 </style>
 </head>
 <body>
 <header>
  <h1>Hermes Office — Live Console</h1>
  <div class="sub">${list.length} agents · live SQLite · @vgalletti/hermes-office · GitHub + Vercel wired</div>
  <div class="bar" id="kpi"></div>
  <div class="bar">
    <input id="q" placeholder="search name / source / model…" oninput="applyFilter()" />
    <span class="pill on" data-f="all" onclick="setF(this)">All</span>
    <span class="pill" data-f="active" onclick="setF(this)">Active</span>
    <span class="pill" data-f="abandoned" onclick="setF(this)">Abandoned</span>
    <span class="pill" data-f="ended" onclick="setF(this)">Ended</span>
    <span class="pill" data-f="thinking" onclick="setF(this)">Thinking</span>
    <span class="pill" data-f="error" onclick="setF(this)">Error</span>
    <span id="conn" class="pill" style="border-color:#f59e0b;color:#f59e0b">connecting…</span>
    <button id="refresh" style="background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer" onclick="manualRefresh()">↻ Refresh</button>
    <button id="reconnect" onclick="forceReconnect()">⟲ Reconnect</button>
    <span class="hint" style="color:#64748b;font-size:11px">stale>2h = abandoned</span>
  </div>
</header>
<main>
  <div class="grid" id="grid"></div>
</main>
<aside>
  <div class="sec"><h3>Activity timeline</h3><div id="timeline"><div class="meta dim">live feed…</div></div></div>
  <div class="sec"><h3>Projects — GitHub</h3><div id="gh"></div></div>
  <div class="sec"><h3>Projects — Vercel</h3><div id="vc"></div></div>
  <div class="sec"><h3>Proactive repairs <span id="rcount" class="meta dim"></span> <button id="rescan" style="background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer">rescan</button></h3><div id="repairs"><div class="meta dim">scanning local code (not websites)…</div></div></div>
  <div class="sec"><h3>Audit log <span class="meta dim">(safety)</span></h3><div id="audit"><div class="meta dim">none yet</div></div></div>
  <div class="sec"><h3>Message board <span class="meta dim">(agents + you)</span></h3>
    <div class="composer">
      <input id="mbFrom" placeholder="from (e.g. you / repair-scanner)" value="you" />
      <textarea id="mbText" placeholder="post a note, question, or status…"></textarea>
      <div style="display:flex;gap:5px">
        <select id="mbKind"><option value="note">note</option><option value="question">question</option><option value="result">result</option><option value="system">system</option></select>
        <input id="mbGroup" placeholder="group (e.g. repairs)" style="flex:1" />
        <button onclick="postBoard()">Post</button>
      </div>
    </div>
    <div class="mbchips" id="mbchips"></div>
    <div id="messages"><div class="meta dim">loading…</div></div>
  </div>
  <div class="sec"><h3>Abandoned <span class="meta dim">(idle &gt;2h · click to inspect)</span></h3><div id="abview"><div class="meta dim">none</div></div></div>
  <div class="sec"><h3>Agent tasks</h3><div id="tickets"><div class="meta dim">none yet</div></div></div>
</aside>
<div id="backdrop" onclick="closeDrawer()"></div>
<div id="drawer">
  <div class="dh">
    <div>
      <h2 style="margin:0 0 2px;font-size:15px" id="dwTitle">Agent</h2>
      <div class="meta dim" id="dwSub"></div>
    </div>
    <button class="copy" onclick="closeDrawer()">✕ Esc</button>
  </div>
  <div class="dtabs">
    <span class="dtab on" data-t="ov" onclick="setTab(this)">Overview</span>
    <span class="dtab" data-t="ms" onclick="setTab(this)">Messages</span>
    <span class="dtab" data-t="tl" onclick="setTab(this)">Timeline</span>
  </div>
  <div class="dbody" id="dbody"></div>
</div>
<div id="status">connecting…</div>
<script>
  const grid = document.getElementById('grid');
  const summary = document.getElementById('summary');
  const detail = document.getElementById('detail');
  const status = document.getElementById('status');
  const AC = { idle:'#64748b', thinking:'#8b5cf6', writing:'#10b981', reading:'#0ea5e9', waiting:'#f59e0b', error:'#ef4444' };
  const STALE_H = ${STALE_H};
  const esc = s => String(s??'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const ageH = a => { const iso=a.lastActiveAt||a.startedAt; if(!iso) return 1e9; return (Date.now()-new Date(iso).getTime())/3.6e6; };
  const cls = a => !a.open ? 'ended' : (ageH(a)>STALE_H ? 'abandoned' : 'active');
  let agents=[], filter='all', q='', selId=null, prevKpi=null;
  // C1/C2/C3: KPI cards from server-side KPIs (single source of truth), clickable
  // to apply matching filter, with delta vs previous snapshot.
  const KPI_DEFS = [
    { key:'active',    label:'Active',    col:'#10b981', f:'active' },
    { key:'thinking',  label:'Thinking',  col:'#8b5cf6', f:'thinking' },
    { key:'errors',    label:'Errors',    col:'#ef4444', f:'error' },
    { key:'abandoned', label:'Abandoned', col:'#f59e0b', f:'abandoned' },
    { key:'tasks',     label:'Tasks',     col:'#0ea5e9', f:null },
    { key:'projects',  label:'Projects',  col:'#818cf8', f:null },
  ];
  function renderKpiFromAgents(){ // C4: derive from the single snapshot
    const k={ active:0, thinking:0, errors:0, abandoned:0, ended:0, total:agents.length, tasks:tickets.length, projects:0 };
    for(const a of agents){ const c=cls(a); if(c==='active')k.active++; else if(c==='abandoned')k.abandoned++; else if(c==='ended')k.ended++; if(a.activity==='thinking')k.thinking++; if(a.activity==='error')k.errors++; }
    k.projects = (window.__projCount||0);
    renderKpi(k);
  }
  function renderKpi(k){
    kpiEl.innerHTML = KPI_DEFS.map(d=>{
      const v=k[d.key]||0, pv=prevKpi?prevKpi[d.key]:undefined;
      const delta = pv===undefined?'':(v>pv?' +'+(v-pv):v<pv?' -'+(pv-v):'');
      const dcol = delta.startsWith(' +')?'#10b981':delta.startsWith(' -')?'#ef4444':'#475569';
      const on = (d.f && d.f===filter)?' on':'';
      return '<div class="kpi'+on+'" style="--kc:'+d.col+'" data-kpi="'+d.f+'"><div class="v">'+esc(v)+'</div><div class="l">'+d.label+'</div><div class="d" style="color:'+dcol+'">'+esc(delta)+'</div></div>';
    }).join('');
    prevKpi = k;
  }
  function kpiClick(f){ if(!f) return; setF({dataset:{f}}); }
  // Delegated click router — replaces all inline onclick handlers so the
  // single-quoted boardHtml string needs no backslash-escaped quotes.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-agent],[data-kpi],[data-repo],[data-confirm],[data-cancel],[data-tk],[data-copy],[data-dismiss],[data-wake],[data-mbg]');
    if (!t) return;
    if (t.dataset.wake) { e.stopPropagation(); return wakeAgent(t.dataset.wake, t.dataset.grp, t.dataset.nm); }
    if (t.dataset.agent) return inspect(t.dataset.agent);
    if (t.dataset.kpi) return kpiClick(t.dataset.kpi);
    if (t.dataset.copy) return navigator.clipboard.writeText(t.dataset.copy);
    if (t.dataset.tk) return dismissTicket(t.dataset.tk);
    if (t.dataset.confirm) return confirmAct(t.dataset.repo, t.dataset.act);
    if (t.dataset.cancel) { const box = t.closest('.confirm'); if (box) box.parentElement.innerHTML = ''; return; }
    if (t.dataset.repo) return act(t.dataset.repo, t.dataset.act);
  });
  function visible(){ return agents.filter(a=>{
    const c=cls(a); if(filter!=='all' && filter!==c && filter!==a.activity) return false;
    if(q){ const s=(a.name+' '+(a.source||'')+' '+(a.model||'')).toLowerCase(); if(!s.includes(q.toLowerCase())) return false; }
    return true; }); }
  function card(a){
    const c=cls(a), col=c==='abandoned'?'#ef4444':(AC[a.activity]||'#64748b');
    const badge=c==='abandoned'?'<span class="badge">ABANDONED</span>':'';
    return '<div class="card'+(c==='abandoned'?' abandoned':'')+(a.id===selId?' sel':'')+'" data-id="'+a.id+'" data-agent="'+a.id+'" style="--accent:'+col+'"><div class="dot"></div>'+
      '<div class="name" title="'+esc(a.name)+'">'+esc(a.name).slice(0,38)+badge+'</div>'+
      '<div class="status">'+a.activity+(a.open?'':' · ended')+'</div>'+
      '<div class="meta">'+(a.model||'?')+' · '+(a.source||'?')+'</div>'+
      '<div class="meta">'+a.messageCount+' msgs · '+a.toolCalls+' tools</div></div>';
  }
  let lastSnap = 0;
  function setConn(state){
    const el = document.getElementById('conn');
    const map = { live:['Live','#10b981'], recon:['Reconnecting…','#f59e0b'], off:['Offline','#ef4444'] };
    const [txt,col] = map[state];
    el.textContent = txt; el.style.color = col; el.style.borderColor = col;
  }
  function render(){
    grid.innerHTML = visible().map(card).join('') || '<div class="meta dim">no matches</div>';
    renderKpiFromAgents();
    const age = lastSnap ? Math.max(0, Math.round((Date.now()-lastSnap)/1000)) : 0;
    status.textContent = 'updated ' + age + 's ago · ' + agents.length + ' agents';
  }
  setInterval(() => { if (agents.length && lastSnap) render(); }, 1000); // B3: tick the "Ns ago"
  function setF(el){ filter=el.dataset.f; document.querySelectorAll('.bar .pill[data-f]').forEach(x=>x.classList.toggle('on',x===el)); render(); }
  function applyFilter(){ q=document.getElementById('q').value; render(); }
  function manualRefresh(){ setConn('recon'); loadProjects(); loadTickets(); } // B4
  function inspect(id){
    selId=id; render();
    const a = agents.find(x=>x.id===id) || {};
    document.getElementById('dwTitle').textContent = (a.name||id).slice(0,46);
    document.getElementById('dwSub').textContent = 'session ' + id;
    openDrawer(); setTab({dataset:{t:'ov'}});
    fetch('/messages?id='+encodeURIComponent(id)).then(r=>r.json()).then(d=>{ dwMsg=d.messages||[]; if(dwTab==='ms') renderDrawer(); else if(dwTab==='tl') renderTimeline(a); });
  }
  function openDrawer(){ document.getElementById('backdrop').classList.add('open'); document.getElementById('drawer').classList.add('open'); }
  function closeDrawer(){ document.getElementById('backdrop').classList.remove('open'); document.getElementById('drawer').classList.remove('open'); }
  function setTab(el){ dwTab=el.dataset.t; document.querySelectorAll('.dtab').forEach(x=>x.classList.toggle('on',x===el)); renderDrawer(); }
  let dwMsg=[], dwTab='ov', dwAuto=true, dwSearch='';
  function renderDrawer(){
    const a = agents.find(x=>x.id===selId)||{}; const b=document.getElementById('dbody');
    if(dwTab==='ov'){
      const age=Math.round(ageH(a));
      b.innerHTML='<div class="ov">'+
        '<div class="row"><span class="k">ID</span><span>'+esc(selId)+' <button class="copy" data-copy="'+esc(selId)+'">copy</button></span></div>'+
        '<div class="row"><span class="k">Status</span><span>'+(a.open?(cls(a)==='abandoned'?'abandoned':'active'):'ended')+'</span></div>'+
        '<div class="row"><span class="k">Activity</span><span>'+(a.activity||'?')+'</span></div>'+
        '<div class="row"><span class="k">Model</span><span>'+(a.model||'?')+'</span></div>'+
        '<div class="row"><span class="k">Source</span><span>'+(a.source||'?')+'</span></div>'+
        '<div class="row"><span class="k">Msgs / Tools</span><span>'+(a.messageCount||0)+' / '+(a.toolCalls||0)+'</span></div>'+
        '<div class="row"><span class="k">Age (h)</span><span>'+age+'</span></div>'+
        (a.startedAt?'<div class="row"><span class="k">Started</span><span>'+a.startedAt+'</span></div>':'')+
        (a.lastActiveAt?'<div class="row"><span class="k">Last active</span><span>'+a.lastActiveAt+'</span></div>':'')+
        (a.gitRepoRoot?'<div class="row"><span class="k">Repo</span><span>'+esc(a.gitRepoRoot)+'</span></div>':'')+
        '</div>';
    } else if(dwTab==='ms'){
      const q=dwSearch.toLowerCase();
      const ms=(q?dwMsg.filter(m=>(((m.text||'')+(m.tool||'')+m.role).toLowerCase().includes(q))):dwMsg).slice(-40);
      b.innerHTML='<input class="msgsearch" placeholder="search messages…" oninput="dwSearch=this.value;renderDrawer()" value="'+esc(dwSearch)+'">'+
        (ms.length?ms.map(m=>{ const who=m.role==='tool'?'<span class="r tool">'+(m.tool||'tool')+'</span>':'<span class="r">'+esc(m.role)+'</span>'; return '<div class="msg">'+who+'<div class="t">'+esc((m.text||'').slice(0,1500))+'</div></div>'; }).join(''):'<div class="meta dim">no messages</div>');
      if(dwAuto) b.scrollTop=b.scrollHeight;
    } else {
      const a2=agents.find(x=>x.id===selId)||{}; renderTimeline(a2);
    }
  }
  function renderTimeline(a){
    const b=document.getElementById('dbody');
    const evs=[];
    evs.push(['created', a.startedAt||'?']);
    evs.push(['status: '+(a.activity||'unknown'), a.lastActiveAt||'?']);
    if(a.open===false) evs.push(['ended', a.lastActiveAt||'?']);
    b.innerHTML='<div class="tl">'+evs.map(e=>'<div class="ev"><b>'+esc(e[0])+'</b> · '+esc(e[1])+'</div>').join('')+'<div class="ev" style="color:#475569">Messages tab has the full log</div></div>';
  }
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeDrawer(); }); // D6
  // projects
  function projCard(name,url,extra,health){
    const h = health||{};
    const badge = h.repairHigh ? '<span class="tag" style="color:#f87171">⚠ '+h.repairHigh+' critical</span>'
      : (h.repairIssues ? '<span class="tag" style="color:#f59e0b">'+h.repairIssues+' notes</span>' : '<span class="tag" style="color:#10b981">healthy</span>');
    return '<div class="proj"><div class="pn">'+esc(name)+'</div>'+badge+
      (url?'<a href="'+esc(url)+'" target="_blank">'+esc(url)+'</a>':'<span class="tag">'+(extra||'')+'</span>')+
      '<div class="acts">'+
        '<button data-repo="'+esc(name)+'" data-act="inspect">Inspect</button>'+
        '<button class="imp" data-repo="'+esc(name)+'" data-act="improve">Improve</button>'+
        '<button class="fin" data-repo="'+esc(name)+'" data-act="finish">Finish</button>'+
      '</div><div id="cf_'+esc(name)+'"></div></div>';
  }
  function loadProjects(){
    fetch('/projects').then(r=>r.json()).then(p=>{
      window.__projCount = (p.github&&p.github.length?p.github.length:0)+(p.vercel&&p.vercel.length?p.vercel.length:0);
      document.getElementById('gh').innerHTML = (p.github&&p.github.length?p.github:'No GitHub repos').map(r=>projCard(r.name,r.url,r.description||'',{repairIssues:r.repairIssues,repairHigh:r.repairHigh})).join('');
      document.getElementById('vc').innerHTML = (p.vercel&&p.vercel.length?p.vercel:'No Vercel projects').map(r=>projCard(r.name,r.url||'#',r.updated||'',{repairIssues:r.repairIssues,repairHigh:r.repairHigh})).join('');
      if(agents.length) renderKpiFromAgents();
    }).catch(e=>{ document.getElementById('gh').innerHTML='<div class="meta dim">projects failed</div>'; });
  }
  // I3: surface proactive-repair findings (proposal-only; never auto-applied)
  function loadRepairs(){
    fetch('/repairs').then(r=>r.json()).then(d=>{
      document.getElementById('rcount').textContent = d.count? '('+d.count+')' : '';
      const rows = (d.repairs||[]).slice(0,40).map(r=>{
        const issues = r.issues.map(i=>'<div style="color:'+(i.sev==='high'?'#f87171':i.sev==='med'?'#f59e0b':'#64748b')+'">'+esc(i.note)+'</div>').join('');
        return '<div class="rk"><b>'+esc(r.name)+'</b><div class="meta dim">'+esc(r.file.replace(/^.*hermes-office/,'…hermes-office').replace(/^.*skills/,'…skills').replace(/^.*Blunt/,'…'))+'</div>'+issues+'</div>';
      });
      document.getElementById('repairs').innerHTML = rows.length? rows.join('') : '<div class="meta dim">no repair findings (clean)</div>';
    }).catch(()=>{});
  }
  // H2: render audit log (safety trail)
  function loadAudit(){
    fetch('/audit').then(r=>r.json()).then(d=>{
      const rows = (d.entries||[]).slice(-30).reverse();
      document.getElementById('audit').innerHTML = rows.length? rows.map(e=>'<div class="meta dim" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(e)+'</div>').join('') : '<div class="meta dim">no actions yet</div>';
    }).catch(()=>{});
  }
  function act(repo,action){
    if(action==='inspect'){ window.open('https://github.com/jasonmanuel-cmd/'+repo, '_blank'); return; }
    const box=document.getElementById('cf_'+repo);
    box.innerHTML='<div class="confirm">Spawn a background Hermes agent to <b>'+action+'</b> <b>'+esc(repo)+'</b>? Works on a NEW branch, opens a PR — never pushes to main without your OK.'+
      '<br><button data-confirm="1" data-repo="'+esc(repo)+'" data-act="'+esc(action)+'">Approve & run</button> <button data-cancel="1">Cancel</button></div>';
  }
  function confirmAct(repo,action){
    fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repo,action,approved:true})}).then(r=>r.json()).then(d=>{
      document.getElementById('cf_'+repo).innerHTML = d.ok? '<div class="meta" style="color:#10b981">started: '+(d.ticket&&d.ticket.id||'ok')+'</div>' : '<div class="meta" style="color:#f87171">'+esc(d.error||d.message||'failed')+'</div>';
      loadTickets();
    });
  }
  // F1/F2/F5: tasks board — columns by status, rich fields, dismiss completed/failed
  function loadTickets(){
    fetch('/tickets').then(r=>r.json()).then(d=>{
      const tks=d.tickets||[];
      if(!tks.length){ document.getElementById('tickets').innerHTML='<div class="meta dim">none yet</div>'; return; }
      const colFor = s => s==='running'?'#10b981':(s==='done'?'#475569':(String(s).startsWith('exited')?'#ef4444':'#475569'));
      const card = t => '<div class="tk" style="--tc:'+colFor(t.status)+'"><span class="dismiss" data-tk="'+esc(t.id)+'">✕</span>'+
        '<div class="repo">'+esc(t.repo)+'</div>'+
        '<div class="meta2">'+esc(t.action)+' · '+esc(t.status)+'</div>'+
        '<div class="meta2">'+(t.startedAt?t.startedAt.slice(11,19):'')+(t.branch?' · '+esc(t.branch):'')+(t.prUrl?' · <a href="'+esc(t.prUrl)+'" target="_blank" style="color:#818cf8">PR</a>':'')+'</div>'+
        (t.lastLine?'<div class="meta2" style="color:#64748b">'+esc(t.lastLine).slice(0,80)+'</div>':'')+'</div>';
      const running = tks.filter(t=>t.status==='running');
      const done = tks.filter(t=>t.status!=='running');
      document.getElementById('tickets').innerHTML =
        '<div class="tkcols"><div><div class="meta dim" style="margin-bottom:4px">Running ('+running.length+')</div>'+running.map(card).join('')+'</div>'+
        '<div><div class="meta dim" style="margin-bottom:4px">Done/Failed ('+done.length+')</div>'+done.map(card).join('')+'</div></div>';
    });
  }
  function dismissTicket(id){
    const i = tickets.findIndex(t=>t.id===id); if(i>=0){ tickets.splice(i,1); persistTickets(); loadTickets(); }
  }
  // E3/E5: live activity timeline (SSE) — click event jumps to related agent
  function loadTimeline(){
    const el = document.getElementById('timeline');
    const te = new EventSource('/events');
    te.onmessage = e => {
      try {
        const d = JSON.parse(e.data);
        const t = new Date(d.t).toLocaleTimeString();
        const ent = String(d.entity || '');
        const agentId = ent.startsWith('agent:') ? ent.slice(6) : '';
        const div = document.createElement('div');
        div.className = 'ev';
        if (agentId) { div.style.cursor = 'pointer'; div.onclick = () => inspect(agentId); }
        div.innerHTML = '<span class="ts">' + t + '</span> <b>' + esc(d.kind) + '</b> ' + esc(d.message);
        el.insertBefore(div, el.firstChild);
        while (el.children.length > 60) el.removeChild(el.lastChild);
      } catch {}
    };
    te.onerror = () => {}; // E5: silent; browser auto-reconnects
  }
  // B1/B2/B5: SSE with backoff reconnect (1s→2s→5s→10s cap) and clean resubscribe.
  let es, backoff = 1000;
  function connect(){
    es = new EventSource('/stream');
    es.onopen = () => { setConn('live'); backoff = 1000; };
    es.onerror = () => {
      setConn(backoff >= 10000 ? 'off' : 'recon');
      es.close(); // B5: drop old handlers before reconnect
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
    es.addEventListener('snapshot', e => { agents = JSON.parse(e.data).agents; lastSnap = Date.now(); render(); renderAbview(); });
  }
  function forceReconnect(){ try { es.close(); } catch {} backoff = 1000; setConn('recon'); connect(); }
  window.addEventListener('online', () => forceReconnect()); // B6: recover when network returns
  connect();

  // ---------- Wave 5: Message board (J) ----------
  let mbFilterGroup = '';
  function fmtTime(t){ try { return new Date(t).toLocaleTimeString(); } catch { return ''; } }
  function mbCard(m){
    const kcls = (m.kind==='result'||m.kind==='question') ? ' '+m.kind : '';
    const g = m.group ? '<span class="mg">'+esc(m.group)+'</span>' : '';
    return '<div class="mb"><div class="mf"><b>'+esc(m.from)+'</b>'+g+'<span class="mk'+kcls+'">'+esc(m.kind)+'</span> <span class="ts">'+fmtTime(m.t)+'</span></div><div class="mt">'+esc(m.text)+'</div></div>';
  }
  function renderBoard(){
    const ms = (mbFilterGroup ? MESSAGES.filter(x=>x.group===mbFilterGroup) : MESSAGES).slice(-80);
    document.getElementById('messages').innerHTML = ms.length ? ms.map(mbCard).reverse().join('') : '<div class="meta dim">no messages</div>';
    const chips = groupsList().map(g=>'<span class="pill'+(g===mbFilterGroup?' on':'')+'" data-mbg="'+esc(g)+'">'+esc(g)+'</span>').join('');
    document.getElementById('mbchips').innerHTML = (chips?chips+' ':'')+'<span class="pill'+(!mbFilterGroup?' on':'')+'" data-mbg="">All</span>';
  }
  function loadBoard(){
    fetch('/messages-board').then(r=>r.json()).then(d=>{ MESSAGES = d.messages||[]; renderBoard(); }).catch(()=>{});
  }
  function postBoard(){
    const from = document.getElementById('mbFrom').value || 'you';
    const text = document.getElementById('mbText').value.trim();
    const kind = document.getElementById('mbKind').value;
    const group = document.getElementById('mbGroup').value.trim();
    if (!text) return;
    fetch('/messages-board', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ from, text, kind, group }) })
      .then(r=>r.json()).then(d=>{ if(d.ok){ document.getElementById('mbText').value=''; loadBoard(); } });
  }
  // live SSE feed
  function connectBoard(){
    const bs = new EventSource('/messages-stream');
    bs.onmessage = e => { try { const m = JSON.parse(e.data); MESSAGES.push(m); if (MESSAGES.length>200) MESSAGES.shift(); renderBoard(); } catch {} };
    bs.onerror = () => {}; // browser auto-reconnects
  }
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-mbg]'); if (c) { mbFilterGroup = c.dataset.mbg; renderBoard(); }
  });

  // ---------- Wave 5: dedicated Abandoned view ----------
  function renderAbview(){
    const ab = agents.filter(a => cls(a)==='abandoned');
    const el = document.getElementById('abview');
    if (!el) return;
    if (!ab.length) { el.innerHTML = '<div class="meta dim">none</div>'; return; }
    el.innerHTML = ab.slice(0, 60).map(a => {
      const last = a.lastActivityAt || a.startedAt || 'unknown';
      const why = (!a.lastActivityAt && a.startedAt) ? ' (no last_activity_at — using started_at)' : '';
      const grp = (a.gitRepoRoot ? a.gitRepoRoot.split(/[\\/]/).pop() : 'abandoned');
      return '<div class="ab" data-agent="'+esc(a.id)+'"><span class="nm">'+esc(a.name).slice(0,42)+'<span class="badge">ABANDONED</span></span>'+
        '<div class="meta2">'+Math.round(ageH(a))+'h idle · last '+esc(last)+why+' · '+(a.model||'?')+'</div>'+
        '<div class="acts" style="margin-top:6px;display:flex;gap:5px">'+
          '<button data-wake="'+esc(a.id)+'" data-grp="'+esc(grp)+'" data-nm="'+esc(a.name)+'">⟲ Wake / rescan</button>'+
          '<button data-agent="'+esc(a.id)+'">Inspect</button>'+
        '</div></div>';
    }).join('');
  }
  // Wake = non-destructive signal: post to board + re-run repair scan (no delete/prune)
  function wakeAgent(id, grp, nm){
    fetch('/messages-board', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ from:'you', text:'Wake signal → '+nm+' ('+id+') — re-running proactive repair scan.', kind:'system', group: grp }) })
      .then(()=>{ fetch('/rescan',{method:'POST'}).then(()=>loadRepairs()).catch(()=>{}); loadBoard(); })
      .catch(()=>{});
  }
  loadProjects(); loadTickets(); loadTimeline(); loadRepairs(); loadAudit(); loadBoard(); connectBoard();
  setInterval(loadTickets, 8000); setInterval(loadProjects, 30000); setInterval(loadRepairs, 60000); setInterval(loadAudit, 15000); setInterval(renderAbview, 5000);
  document.getElementById('rescan').addEventListener('click', () => { document.getElementById('repairs').innerHTML='<div class="meta dim">rescanning…</div>'; fetch('/rescan',{method:'POST'}).then(()=>loadRepairs()); });
</script>
</body></html>`;
}

const PORT = 4173;
server.listen(PORT, () => {
  console.log(`Hermes Office v2 console — ${store.snapshot().length} agents · GitHub+Vercel wired`);
  console.log(`Open: http://127.0.0.1:${PORT}`);
});
process.on('SIGINT', () => server.close());
