#!/usr/bin/env node
/*
 * sync_to_db.mjs — mirror your local Hermes session store into a hosted Postgres.
 *
 * RUNS ON YOUR MACHINE (not the host). Reads the live SQLite store READ-ONLY and
 * upserts sessions + messages into the hosted DB referenced by DATABASE_URL.
 * The hosted visualize.mjs then reads that Postgres. Keep this on a cron
 * (e.g. every 5 min) so the public dashboard stays current.
 *
 * Requires:  npm install pg
 * Usage:     DATABASE_URL=postgres://user:pass@host:5432/db node sync_to_db.mjs
 *            (or set DATABASE_URL in the environment / .env)
 */
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import crypto from 'node:crypto';

const DB_PATH = `${process.env.LOCALAPPDATA}/hermes/profiles/cipher/state.db`;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL not set — nothing to sync to.'); process.exit(1); }

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec('pragma query_only = on;');
const pg = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const now = Math.floor(Date.now() / 1000);

async function syncSessions() {
  const rows = sqlite.prepare(
    `select id, title, source, model, message_count, tool_call_count,
            last_activity_at, last_activity_description, end_reason, pinned,
            git_repo_root, started_at, estimated_cost_usd
     from sessions`
  ).all();
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `insert into sessions (id, title, source, model, message_count, tool_call_count,
        last_activity_at, last_activity_description, end_reason, pinned, git_repo_root,
        started_at, estimated_cost_usd, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (id) do update set
         title=excluded.title, source=excluded.source, model=excluded.model,
         message_count=excluded.message_count, tool_call_count=excluded.tool_call_count,
         last_activity_at=excluded.last_activity_at, last_activity_description=excluded.last_activity_description,
         end_reason=excluded.end_reason, pinned=excluded.pinned, git_repo_root=excluded.git_repo_root,
         started_at=excluded.started_at, estimated_cost_usd=excluded.estimated_cost_usd, updated_at=excluded.updated_at`,
      [r.id, r.title, r.source, r.model, r.message_count ?? 0, r.tool_call_count ?? 0,
       r.last_activity_at ?? null, r.last_activity_description, r.end_reason, r.pinned ? 1 : 0,
       r.git_repo_root, r.started_at ?? null, r.estimated_cost_usd ?? 0, now]
    );
    n++;
  }
  return n;
}

async function syncMessages() {
  let rows = [];
  try {
    rows = sqlite.prepare(
      `select session_id, role, content, tool_name, timestamp from messages`
    ).all();
  } catch { return 0; } // messages table may not exist — skip
  let n = 0;
  for (const m of rows) {
    const mid = crypto.createHash('sha1').update(`${m.session_id}|${m.timestamp}|${m.role}|${m.tool_name || ''}`).digest('hex');
    await pg.query(
      `insert into messages (mid, session_id, role, content, tool_name, timestamp)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (mid) do nothing`,
      [mid, m.session_id, m.role, m.content, m.tool_name, m.timestamp ?? null]
    );
    n++;
  }
  return n;
}

(async () => {
  try {
    const s = await syncSessions();
    const m = await syncMessages();
    console.log(`synced ${s} sessions, ${m} messages -> ${DATABASE_URL.split('@')[1] || 'db'}`);
  } catch (e) {
    console.error('sync failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
})();
