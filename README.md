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

### What a real "launch on Vercel" would require

- A **hosted database** (Supabase / Neon) that mirrors your local session
  store, plus a sync job that copies sessions there on an interval.
- A **hosted always-on server** (Railway, Render, Fly, a VPS, or a long-running
  Vercel Background Function / Cron + a stateful host) running `visualize.mjs`,
  pointed at that hosted DB.
- The Vercel/frontend would then be a thin static client hitting that hosted
  server's API — OR you skip Vercel entirely and just run this on a small VPS
  (cheapest, closest to current behavior).

**Bottom line:** commit this repo for versioning / backup / sharing. To make it
publicly reachable, run it on a VPS or Railway/Render against a hosted DB — do
not expect `vercel deploy` to work.

## Files

- `scripts/visualize.mjs` — the server (board + SSE + live poll + all endpoints).
- `scripts/package.json` — declares `@vgalletti/hermes-office`.
- `scripts/verify_*.sh` — smoke tests.
- `references/` — SQLite store notes + Vercel CLI quirks.

## Safety

- The session store is opened **read-only** (`pragma query_only = on`) — the
  dashboard can never corrupt your live sessions.
- Improve/Finish spawn background agents that are **double-gated** (button +
  confirm) and instructed to never commit to main, never force-push, never
  delete. All actions are written to an append-only `audit.log`.
