# Deploy Hermes Office Live Dashboard — Click-by-Click

Two supported hosts: **Railway** (simplest) or **Render** (free tier). Both run
a real long-lived Node process, so the dashboard works. Vercel does NOT (ephemeral
functions + no `node:sqlite`).

You need ONE thing from your side: a hosted Postgres URL (Supabase/Neon/Railway).
Everything else is copy-paste.

────────────────────────────────────────────────────────
STEP 0 — Get a hosted Postgres URL
────────────────────────────────────────────────────────
Pick one (all have free tiers):

  Supabase:   supabase.com → New project → Settings → Database → copy
              "Connection string" (use the Pooled / 6543 one, or the direct 5432).
  Neon:       neon.tech → New project → copy the psql/connection string.
  Railway:    you'll create Postgres in step 1 anyway (recommended if using Railway).

You'll get a URL like:
  postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
Keep it handy — you paste it in two places.

────────────────────────────────────────────────────────
STEP 1 — Populate the DB from your machine (one time + a cron)
────────────────────────────────────────────────────────
On YOUR Windows machine (where the live session store lives):

  cd C:\Users\blunt\Hermes-Office-Live-Dashboard
  npm install pg
  set DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
  node sync_to_db.mjs

Expected output:  synced 569 sessions, N messages -> host:5432/db
(If messages says 0, that's fine — your store may not expose the messages table.)

Put it on a schedule so the public board stays fresh. Easiest: a PowerShell
scheduled task every 5 min, or just re-run it when you want the board updated.
(Optional: I can generate a Windows Task Scheduler XML for you.)

────────────────────────────────────────────────────────
STEP 2a — Deploy on RAILWAY (recommended, ~2 min)
────────────────────────────────────────────────────────
1. Go to https://railway.app → "Start a New Project".
2. Choose "Deploy from GitHub repo" → authorize → select
   `jasonmanuel-cmd/Hermes-Office-Live-Dashboard`.
3. Railway auto-detects `railway.json` (start: `node scripts/visualize.mjs`).
4. Add a Postgres service:  "+ New" → "Database" → "Postgres".
   Or bring your own (Supabase/Neon) — then skip Railway's DB and just set
   DATABASE_URL in the next sub-step.
5. Click your web service → "Variables" → add:
      DATABASE_URL = postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
6. "Deployments" → it builds (npm install) and starts.
7. Click the generated URL (xxxx.up.railway.app) → you'll see the board.
   Health check is GET /  (configured in railway.json).

────────────────────────────────────────────────────────
STEP 2b — Deploy on RENDER (free tier)
────────────────────────────────────────────────────────
1. Go to https://render.com → "New" → "Web Service".
2. Connect GitHub → select `jasonmanuel-cmd/Hermes-Office-Live-Dashboard`.
3. Settings (auto-filled from render.yaml):
      Build:    npm install
      Start:    node scripts/visualize.mjs
      Health:   /
      Branch:   main
4. Under "Environment" → add secret:
      DATABASE_URL = postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
   (Render injects PORT automatically — don't set it.)
5. "Create Web Service" → waits for your first build.
6. Open the .onrender.com URL → board is live.

────────────────────────────────────────────────────────
STEP 3 — Verify it's working
────────────────────────────────────────────────────────
- Open the deployed URL. You should see the same agent grid you see at
  http://127.0.0.1:4173 (agent count may differ slightly depending on when you
  last ran sync_to_db.mjs).
- If it shows 0 agents: the sync in Step 1 didn't write, or DATABASE_URL on the
  host points at a different/empty DB. Re-run Step 1 and confirm the host's
  DATABASE_URL matches.

────────────────────────────────────────────────────────
NOTES / GOTCHAS
────────────────────────────────────────────────────────
- The public board reflects the LAST sync from your machine. It is NOT live —
  it updates when sync_to_db.mjs runs. Schedule it (every 5 min) for near-real-time.
- Your local dashboard (http://127.0.0.1:4173) is unaffected and still reads the
  live store directly (no DATABASE_URL needed there).
- Never commit DATABASE_URL to the repo. Set it only in the host's dashboard.
- Vercel: still unsupported. Don't waste time `vercel deploy`-ing this.
- Cost: Railway/Render free tier covers a small always-on Node service. Postgres
  free tier (Supabase/Neon) is also free at this data size.

Need a Windows scheduled-task file to auto-run the sync? Ask and I'll generate it.
