-- Hermes Office Dashboard — hosted Postgres schema
-- Run this once on your hosted DB (Supabase/Neon/Railway Postgres), then run
-- sync_to_db.mjs from your machine to populate it. The dashboard reads these
-- tables when DATABASE_URL is set.

create table if not exists sessions (
  id text primary key,
  title text,
  source text,
  model text,
  message_count integer default 0,
  tool_call_count integer default 0,
  last_activity_at bigint,          -- unix seconds
  last_activity_description text,
  end_reason text,
  pinned integer default 0,
  git_repo_root text,
  started_at bigint,                -- unix seconds
  estimated_cost_usd real default 0,
  updated_at bigint default 0
);

-- Per-session messages (drawer "Messages" tab). Unique key avoids dupes on re-sync.
create table if not exists messages (
  mid text primary key,             -- deterministic: session_id|timestamp|role|tool
  session_id text,
  role text,
  content text,
  tool_name text,
  timestamp bigint
);
create index if not exists idx_messages_session on messages (session_id);

-- Helper for the sync upsert (idempotent).
-- sessions:  insert ... on conflict (id) do update set ...
-- messages:  insert ... on conflict (mid) do nothing
