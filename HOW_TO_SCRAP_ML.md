# How to scrape MercadoLibre

MercadoLibre is the one source you **can't** trigger from the UI. Everything
else (Zonaprop, ArgenProp, Remax) runs through the "Analizar" button and the
`scripts/run-analysis.js` CLI. ML lives in its own dedicated script:
`scripts/scrape-ml.js`. This page is the operating manual for that script.

---

## Why is ML separate?

MercadoLibre's anti-bot fraud-detection layer (DataDome + Polycard JS +
in-house heuristics) fingerprints any browser Playwright launches, no matter
how many flags we strip. Symptoms when our normal scraper runs:

- ML answers detail-page navigations with `HTTP 200` + an **empty body**
  and a JS challenge that auto-refreshes the same URL in a loop.
- After 4–10 requests from the same IP, the success rate drops to ~0%.
- The visible Chrome tab "blinks" (continuous reload).

The only reliable workaround is to **attach Playwright via CDP to a Chrome
that the user launched manually**. That session:

- has organic cookies (acquired over real browsing, not pasted in a file),
- carries a fingerprint that matches every prior visit (history, font set,
  mouse-event timings, audio context),
- holds a live login if you signed in normally.

ML's anti-bot can't tell that script is fooling it because every signal
looks like the human who already passed the fraud check is the one
clicking. Success rates from this path are usually 60–95% per run.

The cost: a one-time manual Chrome setup. That's incompatible with a
one-click button on the web app — hence ML is excised from the UI and only
reachable through `scripts/scrape-ml.js`.

---

## Chrome setup

Two options. Pick whichever fits your workflow — both work, they trade off
fingerprint quality vs. convenience.

### Option A — Dedicated parallel Chrome (recommended)

Launches a **second Chrome process** with its own profile, alongside your
regular browser. You don't have to close anything. The dedicated profile
persists in `~/.chrome-ml-scraper` — log in once, leave it.

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-ml-scraper" &
```

First time you run it: a blank Chrome window opens. Go to
<https://www.mercadolibre.com.ar/>, log in, browse for ~5 minutes
(type a few searches, click into a handful of listings, scroll). That
populates DataDome cookies and a basic browsing fingerprint ML trusts.

Subsequent runs: the dedicated profile keeps you logged in and keeps the
fingerprint warm — just relaunch the same command and the session resumes.

You can keep this dedicated Chrome window minimized in the background
indefinitely. The script reuses it across runs. You may want to open it
manually once a week and click around for 30 seconds to "refresh" the
session — ML occasionally invalidates inactive sessions.

### Option B — Use your real Chrome (slightly higher success rate, more disruptive)

Re-launches your **main Chrome** with the debug port. That gives the
script access to your full organic browsing history, real cookies, and the
fingerprint ML knows from years of you using ML normally. Trade-off: you
have to close every Chrome window first, and every other tab you had open
comes back via session restore.

```bash
# 1. Quit Chrome completely (Cmd+Q on the Chrome icon, not just closing the window).
ps aux | grep "Google Chrome.app" | grep -v grep | grep -v Helper
# ↑ should print nothing before you continue

# 2. Re-launch:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &

# 3. Confirm you're still logged into ML (top-right avatar at
#    https://www.mercadolibre.com.ar/ — same profile means same login).
# 4. Optionally browse 30s to warm up cookies/history.
```

### Sanity check (either option)

```bash
curl -s http://localhost:9222/json/version | head -2
```

Should return JSON with `"Browser": "Chrome/…"`. If it returns nothing or
`Connection refused`, the Chrome you launched isn't exposing the debug
port — re-do the setup.

---

## Running the script

```bash
node --env-file=.env scripts/scrape-ml.js <analysis-id>
```

`<analysis-id>` is the UUID shown under "Análisis activo" in the UI, with a
**"copiar id"** button. Both phases (scrape + enrich) run for every barrio
in the analysis.

### Common variants

```bash
# Only re-visit detail pages, don't refresh listing pages
node --env-file=.env scripts/scrape-ml.js <id> --phase=enrich

# Only refresh listing pages (fast — no per-listing detail navigation)
node --env-file=.env scripts/scrape-ml.js <id> --phase=scrape

# Restrict to one barrio (useful for testing or partial re-runs)
node --env-file=.env scripts/scrape-ml.js <id> --neighborhood=nunez

# Re-attempt every incomplete listing even if it was tried in the last 24h
node --env-file=.env scripts/scrape-ml.js <id> --force

# Test with just 5 listings before committing to a long run
node --env-file=.env scripts/scrape-ml.js <id> --phase=enrich --limit=5 --force
```

### What you'll see in the log

```
[chrome-cdp] connected to Chrome/149.0.0.0 at http://localhost:9222
====================================================
 Analysis: nunez · 2-3 amb · 🚗 · …
 Barrios:  Núñez
 Phases:   scrape, enrich
 Pace:     ML_CHANNELS=1 · 8000-25000ms · break every 30 (60000-180000ms)
====================================================
[…] >>> Núñez (nunez)
  [scrape/venta] starting (mode=full)
  [scrape/venta/done] new=12 updated=3 unchanged=89 total=104
  [scrape/alquiler] starting (mode=full)
  [scrape/alquiler/done] new=8 updated=1 unchanged=42 total=51
  [enrich/start] 47 pending
  [enrich] ▶ started 1/47 · in_flight=1 · t=0s
  [enrich] ✓ 1/47 (+1) · ok=1 fail=0 gone=0 · success=100% · t=6s
  [enrich] ▶ started 2/47 · in_flight=1 · t=15s
  …
```

If you see `success=` hovering above 50%, the CDP-attach path is working as
intended. Below 20% sustained means the session got flagged anyway —
usually because the warm-up step was skipped, or because the Chrome window
sat idle for hours and lost its cookies.

### Auto-stop when the session is blown

The script doesn't blindly burn through 2000 listings if MercadoLibre
flagged you. Two triggers stop the run early and print a clear banner:

1. **5 consecutive failures** (default — tune via
   `ML_ABORT_AFTER_CONSECUTIVE_FAILS`). Symptom: every listing in a row hits
   the refresh-loop detector or comes back walled. The script exits with
   code **3** after the 5th, pointing you at the Chrome-fix steps.
2. **`MercadoLibreAuthError`** — ML redirected to `/login` or the body says
   "iniciá sesión". Trips the same banner immediately on the first listing.

The remaining queued listings are marked failed quickly (no detail-page
hits) so the failed count surges, then the banner appears and the script
exits. You do **not** have to Ctrl-C and watch counters.

```
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  STOPPED — ML flagged the session                                        ║
  ║  Reason: 5 consecutive failures (threshold=5) — likely session/finger…   ║
  ║  Fix:                                                                    ║
  ║    1. Switch to the dedicated Chrome window (port 9222).                 ║
  ║    2. Open ML manually, click a few listings, scroll. ~2 min.            ║
  ║    3. …                                                                  ║
  ╚══════════════════════════════════════════════════════════════════════════╝
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean finish — all phases completed for every barrio |
| 1 | Bad arguments / unknown analysis id / CDP unreachable |
| 2 | A phase crashed (unexpected error) |
| 3 | ML flagged the session — banner explains how to fix |

### End-of-run breakdown

The final summary categorises each failed listing so you can tell whether
the problem is your setup or the listings themselves:

```
Enrich: enriched=1840 failed=412 gone=50
Fail breakdown: refresh_loop:280 no_data:90 timeout:32 transient:10
```

| Category | Meaning | Fix |
|---|---|---|
| `auth` | Cookies / session dead. ML redirected to `/login`. | Re-warm your Chrome (steps 1–5 of setup). |
| `blocked` | Anti-bot wall / refresh-loop / DataDome. | Same as `auth` — session is flagged. |
| `timeout` | 45s per-listing deadline exceeded. | Usually transient; retry on the next run. |
| `transient` | Playwright race (tab closed mid-flight). | Retryable. |
| `no_data` | Page loaded but had no `m²` / `ambientes` / `edad`. | **NOT recoverable** — the source genuinely doesn't have that data. |
| `network` | fetch / DNS / TLS error. | Retryable. |
| `other` | Unmatched — check the Pino log lines above. | See raw error. |

`no_data` listings will not be re-attempted for 24h (the
`enrich_attempted_at` cooldown). Add `--force` to bypass and retry
immediately.

---

## Troubleshooting

### "cannot reach Chrome on CDP port"

Chrome isn't running with `--remote-debugging-port=9222`. Go through Steps
1–5 of the setup again.

### "analysis not found"

The UUID you pasted doesn't exist in the local DB. Open the UI, copy a
fresh id from the "Análisis activo" card or the recent-analyses list.

### Success rate sustained < 20%

The session got flagged. Options, in order of effort:

1. Close the Chrome window, repeat Steps 1–4 (re-warm).
2. Take a break for 30–60 min — ML's per-IP rate limit relaxes.
3. Verify the IP matches the one you usually browse from (no VPN flip
   between warm-up and script run).
4. The cookies in `data/ml-cookies.txt` are **not used** by this script
   (CDP-attach bypasses them), so refreshing that file does nothing.

### The Chrome tab "blinks" continuously when the script visits a listing

That's the anti-bot challenge auto-reloading. The script's refresh-loop
detector ([src/scrapers/mercadolibre.js](src/scrapers/mercadolibre.js))
catches it within ~5s and moves on. If it happens to every listing, see
"success rate < 20%" above.

### Hitting "alquiler temporario" listings

These short-term-rental listings use a different ML detail template
without `superficie / ambientes / antigüedad`. The scraper auto-skips them
and marks them `active=0` (they fall out of the pending pool). You should
NOT see those in the enrich logs.

---

## Tunables (env vars)

Defaults are set by `scripts/scrape-ml.js`; anything you export before
running overrides them.

| Var | Default | What |
|---|---|---|
| `CHROME_CDP_URL` | `http://localhost:9222` | DevTools Protocol endpoint to attach to |
| `ML_CHANNELS` | `1` | Concurrent ML tabs (keep at 1 — ML notices parallel tabs) |
| `ML_DELAY_MIN_MS` | `5000` | Lower bound of the jittered pause between listings |
| `ML_DELAY_MAX_MS` | `15000` | Upper bound |
| `ML_BREAK_EVERY` | `50` | Listings between "coffee break" pauses (0 = disable) |
| `ML_BREAK_MIN_MS` | `30000` | Min length of the coffee break |
| `ML_BREAK_MAX_MS` | `60000` | Max length |
| `ML_ABORT_AFTER_CONSECUTIVE_FAILS` | `5` | Stop the whole run after N consecutive fails (0 = never abort). Prevents burning hours after ML flags the session. |
| `AGENT_CONCURRENCY` | `1` | Reserved — the Claude agent fallback isn't used for ML (it can't proxy the user's session), but the value is honored by the shared enrich pipeline. |

For an overnight run with even more padding:

```bash
ML_DELAY_MIN_MS=15000 ML_DELAY_MAX_MS=45000 ML_BREAK_EVERY=20 \
  node --env-file=.env scripts/scrape-ml.js <id> --phase=enrich
```

To disable the "consecutive fails" auto-abort (e.g. you know some listings
will fail structurally with `no_data` and want to just skip them without
stopping the run):

```bash
ML_ABORT_AFTER_CONSECUTIVE_FAILS=0 node --env-file=.env scripts/scrape-ml.js <id>
```

---

## Cron / CI

You need a long-lived Chrome instance the CI runner can attach to. The
practical setups:

- **Personal macOS workstation, scheduled via `launchd`** — keep a
  detached Chrome with `--remote-debugging-port=9222` running on a
  dedicated profile, logged into ML once a week manually, and run the
  script from cron. This is what the project owner uses.
- **A dedicated VM (Mac mini / dedicated server)** with a real Chrome user
  who stays logged in. Fragile because ML occasionally invalidates the
  session, requiring a human to re-login.
- **Headless cloud CI runners (GitHub Actions, etc.) do not work** — the
  IP rotates every run and ML rejects them within minutes. Don't bother.

Suggested cron entry (runs every weekday at 03:00 from the personal
workstation, after Chrome has been left running):

```cron
0 3 * * 1-5  cd /Users/me/real-state-analyzer && /usr/local/bin/node --env-file=.env scripts/scrape-ml.js <analysis-id> >> /tmp/scrape-ml.log 2>&1
```

If the Chrome session is missing or logged out, the script aborts in <2s
with the CDP-unreachable banner, so a failed cron run is loud, not silent.
