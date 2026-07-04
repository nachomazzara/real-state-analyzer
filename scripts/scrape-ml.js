// Standalone MercadoLibre scrape + enrich for a saved analysis.
//
// Why this isn't part of the UI flow: ML's anti-bot fingerprints any
// Playwright-launched Chrome and walls ~90% of detail-page requests. The
// only consistently working path is to attach via CDP to a Chrome instance
// the user launches manually (with --remote-debugging-port=9222) — that
// browser carries organic cookies, real browsing history, and a fingerprint
// ML trusts. See HOW_TO_SCRAP_ML.md for the full setup.
//
// Usage:
//   node --env-file=.env scripts/scrape-ml.js <analysis-id>                     # scrape + enrich for every barrio
//   node --env-file=.env scripts/scrape-ml.js <analysis-id> --phase=enrich      # only re-visit detail pages
//   node --env-file=.env scripts/scrape-ml.js <analysis-id> --phase=scrape      # only refresh the listing pages
//   node --env-file=.env scripts/scrape-ml.js <analysis-id> --neighborhood=nunez --limit=20 --force
//
// Exit codes: 0 OK · 1 bad args / CDP unreachable · 2 fatal during run.

// CDP-attach is mandatory for this script. Set CHROME_CDP_URL BEFORE any
// module imports browser.js — the persistent context decides launch-vs-
// attach at first call. We also pre-set the human-pace env so enrich.js
// picks them up at import time.
function setDefault(name, value) {
  if (process.env[name] == null || process.env[name] === '') {
    process.env[name] = String(value);
  }
}
setDefault('CHROME_CDP_URL', 'http://localhost:9222');
setDefault('ML_CHANNELS', 1);
// 7-24s per listing (was 8-25s; shaved 1s off both bounds per user request).
// Still slow enough to look human but ~12% throughput gain on long runs.
setDefault('ML_DELAY_MIN_MS', 5_000);
setDefault('ML_DELAY_MAX_MS', 15_000);
setDefault('ML_BREAK_EVERY', 50);
setDefault('ML_BREAK_MIN_MS', 30_000);
setDefault('ML_BREAK_MAX_MS', 60_000);
setDefault('AGENT_CONCURRENCY', 1);

// --- CLI arg parsing (kept dependency-free) ---------------------------
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')));
const opts = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => a.slice(2).split('=')),
);

const analysisId = positional[0];
if (!analysisId) {
  console.error('usage: node scripts/scrape-ml.js <analysis-id> [--phase=scrape|enrich] [--neighborhood=<id>] [--limit=N] [--force]');
  console.error('       --phase           subset; default = both phases');
  console.error('       --neighborhood    only this barrio (default: all in the analysis)');
  console.error('       --limit=N         cap listings/barrio in the enrich phase (default 10000)');
  console.error('       --force           bypass 24h enrich_attempted_at cooldown');
  process.exit(1);
}

const requestedPhases = (() => {
  if (!opts.phase) return new Set(['scrape', 'enrich']);
  const list = String(opts.phase).split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of list) {
    if (!['scrape', 'enrich'].includes(p)) {
      console.error(`[scrape-ml] unknown phase: ${p} (valid: scrape, enrich)`);
      process.exit(1);
    }
  }
  return new Set(list);
})();
const force = flags.has('--force');
const limit = Number(opts.limit) || 10_000;
const onlyNeighborhood = opts.neighborhood || null;

// --- CDP reachability probe ------------------------------------------
// Run BEFORE importing anything that touches browser.js so we fail with a
// clear setup banner instead of a stack trace inside connectOverCDP.
try {
  const res = await fetch(`${process.env.CHROME_CDP_URL}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ver = await res.json();
  console.log(`[chrome-cdp] connected to ${ver.Browser} at ${process.env.CHROME_CDP_URL}`);
} catch (err) {
  console.error('');
  console.error('  ╔════════════════════════════════════════════════════════════════════════════╗');
  console.error('  ║  scrape-ml.js: cannot reach Chrome on CDP port                             ║');
  console.error('  ║                                                                            ║');
  console.error('  ║  Easiest setup — launch a DEDICATED Chrome in parallel (no need to         ║');
  console.error('  ║  close your normal browser):                                               ║');
  console.error('  ║                                                                            ║');
  console.error('  ║     /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\        ║');
  console.error('  ║       --remote-debugging-port=9222 \\                                       ║');
  console.error('  ║       --user-data-dir="$HOME/.chrome-ml-scraper" &                         ║');
  console.error('  ║                                                                            ║');
  console.error('  ║  First time only: in the new window, log into mercadolibre.com.ar and      ║');
  console.error('  ║  browse a few listings (~5 min) to warm the session. After that,           ║');
  console.error('  ║  the profile persists — just relaunch the same command.                    ║');
  console.error('  ║                                                                            ║');
  console.error('  ║  Full guide: HOW_TO_SCRAP_ML.md                                            ║');
  console.error('  ║  Or override the port: CHROME_CDP_URL=http://localhost:9223 …              ║');
  console.error('  ╚════════════════════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error(`  (reachability probe failed: ${err.message})`);
  process.exit(1);
}

// --- Resolve the analysis to its neighborhoods -----------------------
const { getAnalysis } = await import('../src/analyses.js');
const { scrapeSingleTarget } = await import('../src/pipeline/orchestrator.js');
const { enrichListingsForSource } = await import('../src/pipeline/enrich.js');
const { readFileSync } = await import('node:fs');
const { config } = await import('../src/config.js');

const analysis = getAnalysis(analysisId);
if (!analysis) {
  console.error(`[scrape-ml] analysis not found: ${analysisId}`);
  console.error('            (copy the id from the UI — "copiar id" button)');
  process.exit(1);
}

const allNeighborhoods = (() => {
  const raw = readFileSync(config.neighborhoodsPath, 'utf8');
  return JSON.parse(raw).neighborhoods || [];
})();
let targets = analysis.neighborhoods
  .map((id) => allNeighborhoods.find((n) => n.id === id))
  .filter(Boolean);
if (onlyNeighborhood) {
  targets = targets.filter((n) => n.id === onlyNeighborhood);
  if (targets.length === 0) {
    console.error(`[scrape-ml] --neighborhood=${onlyNeighborhood} is not part of this analysis`);
    console.error(`            analysis covers: ${analysis.neighborhoods.join(', ')}`);
    process.exit(1);
  }
}

console.log('====================================================');
console.log(` Analysis: ${analysis.label}`);
console.log(` ID:       ${analysis.id}`);
console.log(` Barrios:  ${targets.map((n) => n.display).join(', ')}`);
console.log(` Phases:   ${[...requestedPhases].join(', ')}`);
console.log(` Pace:     ML_CHANNELS=${process.env.ML_CHANNELS} · ${process.env.ML_DELAY_MIN_MS}-${process.env.ML_DELAY_MAX_MS}ms · break every ${process.env.ML_BREAK_EVERY} (${process.env.ML_BREAK_MIN_MS}-${process.env.ML_BREAK_MAX_MS}ms)`);
console.log(` Limits:   force=${force} limit=${limit}/barrio (enrich)`);
console.log('====================================================');

const t0 = Date.now();
const totals = { scrape_new: 0, scrape_updated: 0, enriched: 0, failed: 0, gone: 0 };
const totalFailBuckets = Object.create(null);
let hadFatal = false;

for (const neighborhood of targets) {
  console.log(`\n[${new Date().toISOString()}] >>> ${neighborhood.display} (${neighborhood.id})`);

  // PHASE 1 — scrape (listing pages). Sequential venta + alquiler. We use
  // scrapeSingleTarget directly so the orchestrator's per-source filter
  // (which excludes ML from UI flows) doesn't apply.
  if (requestedPhases.has('scrape')) {
    for (const operation of ['venta', 'alquiler']) {
      try {
        const result = await scrapeSingleTarget({
          source: 'mercadolibre',
          neighborhood,
          operation,
          mode: 'full',
          onProgress: (p) => {
            if (p.status === 'starting') {
              console.log(`  [scrape/${operation}] starting (mode=${p.mode})`);
            }
          },
        });
        const counts = result?.counts || { new: 0, updated: 0, unchanged: 0, total: 0 };
        console.log(`  [scrape/${operation}/done] new=${counts.new} updated=${counts.updated} unchanged=${counts.unchanged} total=${counts.total}`);
        totals.scrape_new += counts.new;
        totals.scrape_updated += counts.updated;
        if (!result?.ok && result?.error) {
          console.error(`  [scrape/${operation}/err] ${result.error}`);
        }
      } catch (err) {
        hadFatal = true;
        console.error(`  [scrape/${operation}/crash] ${err.message}`);
      }
    }
  }

  // PHASE 2 — enrich (detail pages).
  if (requestedPhases.has('enrich')) {
    const phaseStart = Date.now();
    let lastStarted = 0;
    let lastDone = 0;
    let lastFailedCount = 0;
    try {
      const result = await enrichListingsForSource({
        source: 'mercadolibre',
        neighborhood: neighborhood.id,
        limit,
        force,
        onProgress: (p) => {
          if (p.status === 'starting') {
            console.log(`  [enrich/start] ${p.total ?? 0} pending`);
            return;
          }
          if (p.status === 'done') {
            const mins = ((Date.now() - phaseStart) / 60_000).toFixed(1);
            console.log(`  [enrich/done] enriched=${p.enriched ?? 0} failed=${p.failed ?? 0} gone=${p.gone ?? 0}/${p.total ?? 0} in ${mins}min`);
            return;
          }
          const started = p.started ?? 0;
          const done = (p.enriched ?? 0) + (p.failed ?? 0) + (p.gone ?? 0);
          const total = p.total ?? '?';
          if (started > lastStarted) {
            lastStarted = started;
            const elapsedSec = ((Date.now() - phaseStart) / 1000).toFixed(0);
            console.log(`  [enrich] ▶ started ${started}/${total} · in_flight=${p.in_flight ?? 0} · t=${elapsedSec}s`);
          }
          if (done > lastDone) {
            const delta = done - lastDone;
            const prevFailed = lastFailedCount;
            lastDone = done;
            lastFailedCount = p.failed ?? 0;
            const elapsedSec = ((Date.now() - phaseStart) / 1000).toFixed(0);
            const okRate = done > 0 ? ((p.enriched ?? 0) / done * 100).toFixed(0) : '0';
            // Condensed running tally by failure reason — only shown when
            // there ARE failures, so the happy path stays clean. Example
            // suffix: `[refresh_loop:7 timeout:3 no_data:2]`
            const buckets = p.fail_buckets || {};
            const bucketStr = (p.failed ?? 0) > 0
              ? ' [' + Object.entries(buckets)
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => `${k}:${n}`)
                .join(' ') + ']'
              : '';
            // If the increment came from a NEW fail, tag the line with the
            // reason category so the user sees what just went wrong without
            // grepping pino JSON.
            const failedJumped = (p.failed ?? 0) > prevFailed;
            const reasonTag = (failedJumped && p.last_failure?.category)
              ? ` ← ${p.last_failure.category}`
              : '';
            console.log(`  [enrich] ✓ ${done}/${total} (+${delta}) · ok=${p.enriched} fail=${p.failed}${bucketStr} gone=${p.gone} · success=${okRate}% · t=${elapsedSec}s${reasonTag}`);
          }
        },
      });
      if (result?.skipped) {
        console.log(`  [enrich] skipped: ${result.reason}`);
      } else if ((result?.enriched ?? 0) === 0 && (result?.failed ?? 0) === 0 && (result?.gone ?? 0) === 0) {
        console.log('  [enrich] (nothing pending)');
      }
      totals.enriched += result?.enriched ?? 0;
      totals.failed += result?.failed ?? 0;
      totals.gone += result?.gone ?? 0;
      // Accumulate the per-category breakdown across barrios so the end
      // banner can show e.g. `failed=23 (refresh_loop:14 timeout:6 no_data:3)`.
      for (const [cat, n] of Object.entries(result?.failBuckets || {})) {
        totalFailBuckets[cat] = (totalFailBuckets[cat] || 0) + n;
      }
      // ML aborted mid-run (session flagged / auth broken). Surface a clear
      // banner instead of letting the user wonder why fails counted up
      // suddenly. Stop iterating the rest of the barrios — fixing the
      // Chrome session is the only useful next step.
      if (result?.aborted) {
        console.error('');
        console.error('  ╔══════════════════════════════════════════════════════════════════════════╗');
        console.error('  ║  STOPPED — ML flagged the session                                        ║');
        console.error('  ║                                                                          ║');
        console.error(`  ║  Reason: ${(result.abortReason || 'unknown').slice(0, 64).padEnd(64)} ║`);
        console.error('  ║                                                                          ║');
        console.error('  ║  Fix:                                                                    ║');
        console.error('  ║    1. Switch to the dedicated Chrome window (port 9222).                 ║');
        console.error('  ║    2. Open ML manually, click a few listings, scroll. ~2 min.            ║');
        console.error('  ║    3. If listings still load weird in YOUR window, ML rate-limited       ║');
        console.error('  ║       this IP. Wait 30-60 min before retrying.                           ║');
        console.error('  ║    4. Re-run the script.                                                 ║');
        console.error('  ║                                                                          ║');
        console.error('  ║  Full diagnostics: HOW_TO_SCRAP_ML.md (Troubleshooting)                  ║');
        console.error('  ╚══════════════════════════════════════════════════════════════════════════╝');
        console.error('');
        process.exit(3);
      }
    } catch (err) {
      hadFatal = true;
      console.error(`  [enrich/crash] ${err.message}`);
    }
  }
}

const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
const failBreakdown = Object.entries(totalFailBuckets)
  .filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k}:${n}`)
  .join(' ');
console.log('\n====================================================');
console.log(` Done in ${elapsedMin} min`);
console.log(` Scrape: new=${totals.scrape_new} updated=${totals.scrape_updated}`);
console.log(` Enrich: enriched=${totals.enriched} failed=${totals.failed} gone=${totals.gone}`);
if (failBreakdown) {
  console.log(` Fail breakdown: ${failBreakdown}`);
  console.log('   auth        cookies/session dead. Re-warm the Chrome (HOW_TO_SCRAP_ML.md).');
  console.log('   blocked     anti-bot wall / refresh-loop. Same fix as auth.');
  console.log('   timeout     45s per-listing deadline. Usually a slow load — retryable next run.');
  console.log('   no_data     page rendered but had no m²/ambientes/edad. Source genuinely lacks the data — re-runs won\'t help.');
  console.log('   transient   one-off Playwright race (page closed mid-flight). Retryable next run.');
  console.log('   network     fetch/DNS layer. Retryable next run.');
}
console.log('====================================================');
process.exit(hadFatal ? 2 : 0);
