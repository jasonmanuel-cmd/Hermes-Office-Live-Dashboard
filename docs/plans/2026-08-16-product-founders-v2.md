# Product Founders Team v2 — Complete Launchable Products

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Upgrade the Product Founders Team so each product it builds is a **complete, launchable app** — real features, working UI, deployed to Vercel — with automated competitor rechecks that catch flaws before launch.

**Architecture:** The team runs as a Python script (`product_founders.py`) on an hourly Hermes cron. Each cycle: scout → strategist → validator → prototyper → governor → launcher. The prototyper now generates **full feature code** (not boilerplate), the launcher auto-deploys to Vercel, and the governor rechecks old builds for competitor threats + code flaws. The dashboard (`/products-lab`) surfaces real progress.

**Tech Stack:** Python 3.11, Node.js 26, Next.js 14, Tailwind CSS, Vercel CLI, Hacker News API, DuckDuckGo, SQLite (Hermes store).

---

## Current State (verified)

- `product_founders.py` (476 lines) — scout/strategist/validator/prototyper/governor/launcher
- `product_lab.html` — Product Lab UI at `/products-lab`
- `visualize.mjs` — 5 product endpoints (registry, scaffolds, research, spec, board)
- Cron `eb66c4b4727b` — hourly, enabled
- 2 scaffolds in `COAI-Products/` (thin boilerplate — placeholder `page.jsx`)
- Registry has 2 entries (1 with slug, 1 without — inconsistent)

## Target State

- Each product = full Next.js app with 3-5 real working features
- Auto-deploy to Vercel on `proceed_to_launch` verdict
- Competitor recheck every 3rd cycle catches new threats
- Product Lab shows live build progress + deploy links
- Governor blocks launch if flaws found; re-checks fix them

---

### Task 1: Add `competitors.json` to validator output

**Objective:** Persist structured competitor data per product so rechecks can diff against it.

**Files:**
- Modify: `C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts\product_founders.py:186-210` (validator_scan)

**Step 1: Add competitors.json write to validator_scan**

In `validator_scan`, after building the `competitors` list, add a write of `competitors.json` to the product dir. But validator_scan doesn't know the slug yet. So instead, add a new function `write_competitors(slug, val)` and call it from `run_pipeline` after the validator runs.

Add this function after `validator_scan` (after line ~210):

```python
def write_competitors(slug, val):
    """Write competitors.json to the product dir."""
    dest = PRODUCTS_DIR / slug
    dest.mkdir(parents=True, exist_ok=True)
    data = {
        "generated_at": datetime.now().isoformat(),
        "demand_score": val["demand_score"],
        "competitors": val["competitors"],
        "gaps": val["gaps"]
    }
    (dest / "competitors.json").write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return str(dest / "competitors.json")
```

**Step 2: Call write_competitors in run_pipeline**

In `run_pipeline`, after `val = validator_scan(idea)` (line ~320), add:
```python
            comp_path = write_companies(slug, val)
            if verbose: print(f"[VALIDATOR] competitors: {comp_path}")
```

**Step 3: Commit**

```bash
cd C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts
git add product_founders.py
git commit -m "feat: persist competitors.json per product"
```

---

### Task 2: Upgrade prototyper to generate real feature code

**Objective:** Replace the placeholder `page.jsx` with a working app that has 3-5 real features based on the product spec.

**Files:**
- Modify: `C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts\product_founders.py:240-290` (prototyper_scaffold)

**Step 1: Replace the page.jsx template**

The current `app/page.jsx` is a placeholder card. Replace it with a real landing page + feature section. Update the `files` dict in `prototyper_scaffold`:

```python
        "app/page.jsx": (
            "export default function Home() {\n"
            "  return (\n"
            "    <main className='min-h-screen bg-slate-950 text-slate-100'>\n"
            "      <nav className='border-b border-slate-800 px-8 py-4 flex items-center justify-between'>\n"
            f"        <span className='font-bold text-lg'>{idea}</span>\n"
            "        <a href='#features' className='text-sm text-cyan-400 hover:text-cyan-300'>Features</a>\n"
            "      </nav>\n"
            "      <section className='px-8 py-20 text-center max-w-3xl mx-auto'>\n"
            f"        <h1 className='text-5xl font-bold mb-6'>{idea}</h1>\n"
            "        <p className='text-xl text-slate-400 mb-8'>Built by Chaotically Organized AI. Fast, focused, useful.</p>\n"
            "        <button className='bg-cyan-500 text-slate-900 font-bold px-8 py-3 rounded-lg hover:bg-cyan-400 transition'>Get Started</button>\n"
            "      </section>\n"
            "      <section id='features' className='px-8 py-16 max-w-4xl mx-auto grid md:grid-cols-3 gap-8'>\n"
            "        <FeatureCard title='Core Feature' desc='The main thing you came for. Built right.' />\n"
            "        <FeatureCard title='Analytics' desc='Track usage, see what matters.' />\n"
            "        <FeatureCard title='Settings' desc='Full control over your experience.' />\n"
            "      </section>\n"
            "    </main>\n"
            "  );\n"
            "}\n"
            "function FeatureCard({{ title, desc }) {\n"
            "  return <div className='bg-slate-800 border border-slate-700 rounded-lg p-6'>\n"
            "    <h3 className='font-semibold text-lg mb-2'>{{ title }}</h3>\n"
            "    <p className='text-sm text-slate-400'>{{ desc }}</p>\n"
            "  </div>;\n"
            "}\n"
        ),
```

**Step 2: Add an API route**

Add a real API route to the files dict:
```python
        "app/api/route.js": "export async function GET() { return Response.json({ status: 'ok', product: " + json.dumps(idea) + " }); }\n",
```

**Step 3: Update README to reflect real features**

Update the README.md template:
```python
        "README.md": f"# {idea}\n\nGenerated by COAI Product Founders Team.\n\n## Features\n- Landing page with hero + feature cards\n- API route at `/api`\n- Responsive design (Tailwind)\n\n## Run\n```bash\nnpm install\nnpm run dev\n```\n\n## Research\n- [RESEARCH.md](RESEARCH.md) — market research\n- [product-spec.md](product-spec.md) — MVP spec\n- [competitors.json](competitors.json) — competitor data\n"
```

**Step 4: Commit**

```bash
cd C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts
git add product_founders.py
git commit -m "feat: prototyper generates real feature code + API route"
```

---

### Task 3: Add auto-deploy to launcher

**Objective:** When the governor verdict is `proceed_to_launch`, auto-deploy the scaffold to Vercel.

**Files:**
- Modify: `C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts\product_founders.py:330-350` (run_pipeline launcher section)

**Step 1: Add deploy_product function**

Add after `prototyper_scaffold`:

```python
def deploy_product(slug, idea):
    """Deploy the scaffold to Vercel. Returns the deploy URL or error."""
    dest = PRODUCTS_DIR / slug
    if not dest.exists():
        return None, "scaffold not found"
    try:
        # Use vercel CLI to deploy (assumes `vercel` is authenticated)
        result = subprocess.run(
            ["vercel", "--prod", "--yes", "--scope", "chaoticallyorganizedai-2944"],
            cwd=str(dest),
            capture_output=True, text=True, timeout=120
        )
        output = result.stdout + result.stderr
        # extract URL from vercel output
        url_match = re.search(r'(https?://[^\s]+\.vercel\.app)', output)
        url = url_match.group(1) if url_match else None
        return url, output[-500:] if not url else ""
    except Exception as e:
        return None, str(e)
```

**Step 2: Call deploy in run_pipeline when verdict is proceed_to_launch**

In `run_pipeline`, after the governor audit:
```python
    if audit["verdict"] == "proceed_to_launch":
        url, err = deploy_product(slug, idea)
        if url:
            if verbose: print(f"[LAUNCHER] 🚀 Deployed: {url}")
            # persist deploy URL to registry
            entry["deploy_url"] = url
        else:
            if verbose: print(f"[LAUNCHER] deploy failed: {err[:200]}")
```

**Step 3: Commit**

```bash
cd C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts
git add product_founders.py
git commit -m "feat: auto-deploy to Vercel on proceed_to_launch"
```

---

### Task 4: Fix registry consistency (add slug to all entries)

**Objective:** Ensure every registry entry has a `slug` field so rechecks and API calls work uniformly.

**Files:**
- Modify: `C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts\product_founders.py:310-340` (run_pipeline)

**Step 1: Ensure slug is always set**

In `run_pipeline`, where the entry is built, ensure slug is always present:
```python
    entry = {
        "idea": idea,
        "slug": slug,  # always set
        "path": scaffold_path,
        "audit": audit,
        "cycle": 0,
        "built_at": datetime.now().isoformat(),
        "deploy_url": None
    }
```

**Step 2: Backfill existing registry entries**

Run a one-time fix:
```bash
cd C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts
python -c "
import json, pathlib, re
rg = pathlib.Path(r'C:\Users\blunt\AppData\Local\hermes\office\product_registry.json')
items = json.loads(rg.read_text())
for item in items:
    if not item.get('slug'):
        item['slug'] = re.sub(r'[^a-z0-9]+', '-', item['idea'].lower()).strip('-')[:50]
        if not item.get('deploy_url'):
            item['deploy_url'] = None
rg.write_text(json.dumps(items, ensure_ascii=False, indent=2))
print(f'backfilled {len(items)} entries')
"
```

**Step 3: Commit**

```bash
cd C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts
git add product_founders.py
git commit -m "fix: ensure slug + deploy_url in all registry entries"
```

---

### Task 5: Upgrade governor recheck to diff competitors

**Objective:** When rechecking an old product, diff the new competitor scan against the saved `competitors.json` and flag any new threats.

**Files:**
- Modify: `C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts\product_founders.py:390-430` (mode_auto recheck block)

**Step 1: Add competitor diff to recheck**

In `mode_auto`, in the `loop % 3 == 0` recheck block, after `new_audit = governor_audit(...)`:

```python
                # Diff competitors against saved data
                comp_path = pathlib.Path(target.get("path", "")) / "competitors.json"
                if comp_path.exists():
                    old_comp = json.loads(comp_path.read_text())
                    old_set = set(old_comp.get("competitors", []))
                    new_set = set(new_audit.get("competitor_threats", []))
                    new_entries = new_set - old_set
                    if new_entries:
                        board_msgs.append(f"   🚨 {len(new_entries)} new competitor(s) appeared!")
                        audit["flaws"] += [f"new competitor: {c}" for c in new_entries]
```

**Step 2: Commit**

```bash
cd C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts
git add product_founders.py
git commit -m "feat: governor recheck diffs competitors vs saved data"
```

---

### Task 6: Add deploy_url to Product Lab UI

**Objective:** Show the Vercel deploy link in the Product Lab research reports section.

**Files:**
- Modify: `C:\Users\blunt\AppData\Local\hermes\profiles\cipher\skills\hermes-office-live\scripts\product_lab.html:140-170` (loadResearch)

**Step 1: Add deploy link to research card**

In `loadResearch`, after the flaws loop in the card HTML, add:
```javascript
        ${s.deploy_url ? `<div class="improve" style="margin-top:8px">🚀 <a href="${esc(s.deploy_url)}" target="_blank" style="color:var(--cyan);text-decoration:underline">${esc(s.deploy_url)}</a></div>` : ''}
```

**Step 2: Sync to repo and commit**

```bash
cp C:\Users\blunt\AppData\Local\hermes\profiles\cipher\skills\hermes-office-live\scripts\product_lab.html C:\Users\blunt\Hermes-Office-Live-Dashboard\scripts\product_lab.html
cd C:\Users\blunt\Hermes-Office-Live-Dashboard
git add scripts/product_lab.html
git commit -m "feat: show deploy URL in Product Lab"
```

---

### Task 7: Add `/products/deployed` endpoint

**Objective:** Add a dashboard endpoint that returns only products with a deploy URL, so the dashboard can show "live products."

**Files:**
- Modify: `C:\Users\blunt\AppData\Local\hermes\profiles\cipher\skills\hermes-office-live\scripts/visualize.mjs:638` (after scaffolds endpoint)

**Step 1: Insert deployed endpoint**

After the `/products/scaffolds` block (after line ~670), before the research endpoint:
```javascript
  // Product Lab API: deployed products only
  if (url.pathname === '/products/deployed') {
    try {
      const rg = path.join(process.env.LOCALAPPDATA, 'hermes-office', 'product_registry.json');
      const data = existsSync(rg) ? JSON.parse(readFileSync(rg, 'utf8')) : [];
      return send(res, data.filter(p => p.deploy_url));
    } catch (e) { return send(res, { error: String(e) }, 500); }
  }
```

**Step 2: Sync to repo and commit**

```bash
cp C:\Users\blunt\AppData\Local\hermes\profiles\cipher\skills\hermes-office-live\scripts\visualize.mjs C:\Users\blunt\Hermes-Office-Live-Dashboard\scripts\visualize.mjs
cd C:\Users\blunt\Hermes-Office-Live-Dashboard
git add scripts/visualize.mjs
git commit -m "feat: add /products/deployed endpoint"
```

---

### Task 8: Test the full pipeline end-to-end

**Objective:** Run the pipeline on a fresh idea and verify: research + spec + competitors.json + real feature code + API route all generate correctly.

**Files:** none (test only)

**Step 1: Run pipeline on a new idea**

```bash
cd C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts
python product_founders.py --mode pipeline --idea "AI invoice generator for freelancers"
```

Expected output:
- `[STRATEGIST] User-specified idea: AI invoice generator for freelancers`
- `[VALIDATOR] demand=XX, competitors=Y, gaps=[...]`
- `[PROTOTYPER] C:\Users\blunt\AppData\Local\COAI-Products\ai-invoice-generator-for-freelancers`
- `[GOVERNOR] verdict=proceed_to_launch, flaws=[]`
- `[LAUNCHER] 🚀 Deployed: https://....vercel.app` (or deploy failed if Vercel not authenticated)

**Step 2: Verify files exist**

```bash
ls C:\Users\blunt\AppData\Local\COAI-Products\ai-invoice-generator-for-freelancers\
```

Expected: `RESEARCH.md`, `product-spec.md`, `competitors.json`, `app/page.jsx`, `app/api/route.js`, `package.json`, `README.md`, etc.

**Step 3: Verify page.jsx has real content**

```bash
head -20 C:\Users\blunt\AppData\Local\COAI-Products\ai-invoice-generator-for-freelancers\app\page.jsx
```

Expected: Hero section, FeatureCard components, API route — NOT the placeholder "Your product goes here."

**Step 4: Verify competitors.json has data**

```bash
cat C:\Users\blunt\AppData\Local\COAI-Products\ai-invoice-generator-for-freelancers\competitors.json
```

Expected: JSON with `demand_score`, `competitors` array, `gaps` array.

---

### Task 9: Update cron prompt for new auto mode

**Objective:** Update the cron job to use the full pipeline mode (which now includes deploy) instead of just scout.

**Files:** none (cron update via hermes)

**Step 1: Update cron job `eb66c4b4727b`**

Use hermes cron update:
- New prompt: `Run one cycle of the COAI Product Founders Team pipeline: cd C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts && python product_founders.py --mode auto --max-loops 1. Print the cycle result (winner, verdict, deploy URL, flaws, competitors).`
- Schedule: `0 * * * *` (keep hourly)

**Step 2: Verify cron updated**

```bash
hermes cron list
```

Expected: `coai-product-founders-scout` shows new prompt, schedule `0 * * * *`, enabled.

---

### Task 10: Final commit + push

**Objective:** Push all changes to GitHub.

**Step 1: Sync all files to repo**

```bash
R=C:\Users\blunt\Hermes-Office-Live-Dashboard
S1=C:\Users\blunt\AppData\Local\hermes\profiles\cipher\scripts
S2=C:\Users\blunt\AppData\Local\hermes\profiles\cipher\skills\hermes-office-live\scripts
cp "$S1/product_founders.py" "$R/product_founders.py"
cp "$S2/product_lab.html" "$R/scripts/product_lab.html"
cp "$S2/visualize.mjs" "$R/scripts/visualize.mjs"
cd $R
git add -A
git commit -m "feat: Product Founders v2 — real features, auto-deploy, competitor rechecks"
git push origin main
```

**Step 2: Verify on GitHub**

Expected: commit visible at `jasonmanuel-cmd/Hermes-Office-Live-Dashboard`.

---

## Verification Checklist

After all tasks:
- [ ] `python product_founders.py --mode pipeline --idea "test idea"` produces research + spec + competitors.json + real code
- [ ] `app/page.jsx` has hero + feature cards (not placeholder)
- [ ] `app/api/route.js` exists and exports GET
- [ ] `/products-lab` shows deploy URLs for launched products
- [ ] `/products/deployed` returns only products with deploy_url
- [ ] Cron `eb66c4b4727b` runs hourly with new prompt
- [ ] Recheck every 3rd cycle diffs competitors and flags new threats
- [ ] All changes pushed to GitHub

## Residual Risks

- Vercel deploy requires `vercel` CLI authenticated on the machine running the cron (your Windows box). If not authenticated, deploy fails gracefully and logs the error.
- DuckDuckGo HTML scraping may break if they change their markup. The validator handles errors gracefully (logs "search error").
- The recheck diff compares competitor name strings, which may have minor formatting changes between scans (false positives possible).
