# Hermes Office — Live Agent-Activity Dashboard

A self-contained Node server that renders a **live web board** of Hermes Agent
sessions, reading the **real SQLite session store** directly (no export step).
Each session is mapped through `@vgalletti/hermes-office`'s `sessionToAgent()`
and run through its `OfficeEventStore` event reducer, then pushed to the
browser over SSE.

## What it shows

- **Agent grid**: 560+ sessions, color-coded by activity (idle / thinking /
  writing / reading / waiting / error), with Active / Abandoned / Ended pills.
- **KPI header**: live counts (Active, Thinking, Errors, Abandoned, Tasks, Projects).
- **Agent drawer**: click any agent → Overview / Messages / Timeline tabs.
- **Projects panel**: live GitHub repos + Vercel projects, with Inspect / Improve / Finish
  (double-gated approval; never pushes to main without your OK).
- **Activity timeline**: live event feed (SSE).
- **Proactive repair scanner**: safe static checks over local code (no websites).
- **Message board**: shared agent↔you comms over SSE, persisted to JSON, with groups.
- **Abandoned view**: idle>2h sessions with age / last-activity / why, plus a
  non-destructive "Wake / rescan" action.
- **Reconnect hardening**: manual Reconnect button + auto-recover on `online`.

## Run (local)

```bash
npm install
npm install @vgalletti/hermes-office
node scripts/visualize.mjs
# open http://127.0.0.1:4173
```

Requires Node >= 22.5 (uses the built-in `node:sqlite`). The store path defaults
to `%LOCALAPPDATA%/hermes/profiles/cipher/state.db`. Override with env vars
`--db`, `--stale`, or set `LOCALAPPDATA`.

## Verify

```bash
bash scripts/verify_all.sh   # hits every endpoint + checks W5 UI markers
```

## ⚠️ CAN IT RUN ON VERCEL? (read before deploying)

**No — not as-is.** This is a **long-running local process** with direct
filesystem access to your machine, not a static site or a stateless serverless
function. Three hard blockers on Vercel:

1. **No local `state.db`.** Vercel's serverless functions have no access to
   `C:\Users\blunt\...` or any persistent local SQLite file. The 560+ agents
   come from *your* machine's session store.
2. **No persistent process.** Vercel functions are ephemeral (spin up per
   request, max ~60s). `visualize.mjs` is a forever-running `http.server` with
   a 5s poll loop — it does not fit the serverless model.
3. **`node:sqlite` + `execFileSync` shell calls** (repair scanner runs
   `python -c` / `node --check`) are sandboxed/unavailable in Vercel's runtime.

**Bottom line:** do NOT `vercel deploy` this. But it IS fully deployable to a
real host (Railway / Render / any VPS) against a hosted Postgres. That's the
supported public-launch path — see **Deploying** below.

## Deploying (Railway / Render / VPS) — supported

The server is database-pluggable: with no `DATABASE_URL` it reads your local
SQLite store (the default, on your machine); with `DATABASE_URL` set it reads a
hosted Postgres instead. Same UI, same endpoints.

### One-time setup
1. Create a hosted Postgres (Supabase / Neon / Railway Postgres). Get its URL.
2. Run the schema:  `psql "$DATABASE_URL" -f schema.sql`
   (or paste `schema.sql` into the provider's SQL editor).
3. On YOUR MACHINE, install the sync driver and run the sync:
   ```bash
   npm install pg
   DATABASE_URL=postgres://user:pass@host:5432/db node sync_to_db.mjs
   ```
   This mirrors your local sessions (+ messages) into the hosted DB, read-only
   on the source side. Put it on a cron (every 5 min) to keep the public board live.
4. Deploy the repo to Railway (`railway.json` provided) or Render (`render.yaml`
   provided):
   - Build: `npm install`  ·  Start: `node scripts/visualize.mjs`
   - Set env `DATABASE_URL` to the hosted Postgres URL. `PORT` is injected.
   - Health check: `GET /`
5. Open the deployed URL — you'll see the same board, now public.

### Local (default)
```bash
npm install && npm install @vgalletti/hermes-office
node scripts/visualize.mjs        # reads local state.db; http://127.0.0.1:4173
```

> Note: Vercel is still not suitable (ephemeral functions + no `node:sqlite`).
> Railway/Render run a real long-lived Node process, so they work.

## Files

- `scripts/visualize.mjs` — the server (board + SSE + live poll + all endpoints).
- `sync_to_db.mjs` — mirrors local store → hosted Postgres (run on your machine).
- `schema.sql` — hosted Postgres tables.
- `railway.json` / `render.yaml` — one-click deploy configs.
- `scripts/package.json` — declares `@vgalletti/hermes-office`.
- `scripts/verify_*.sh` — smoke tests.
- `references/` — SQLite store notes + Vercel CLI quirks.

## Safety

- The session store is opened **read-only** (`pragma query_only = on`) — the
  dashboard can never corrupt your live sessions.
- The sync (`sync_to_db.mjs`) only READS your local store and WRITES to the
  separate hosted DB — it never mutates your local sessions.
- Improve/Finish spawn background agents that are **double-gated** (button +
  confirm) and instructed to never commit to main, never force-push, never
  delete. All actions are written to an append-only `audit.log`.
