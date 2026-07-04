// Run a saved analysis end-to-end from the CLI (Zonaprop + ArgenProp + Remax).
//
// Usage:
//   node --env-file=.env scripts/run-analysis.js <analysis-id>                  # scrape + enrich + geocode, all 3 sources
//   node --env-file=.env scripts/run-analysis.js <analysis-id> --skip-scrape    # only re-enrich + geocode
//   node --env-file=.env scripts/run-analysis.js <analysis-id> --source=zonaprop
//
// Designed for CI / cron — same as the UI's "Analizar" button but blocking
// (waits for enrich + geocode to finish before exiting). MercadoLibre is
// NOT handled here: ML needs CDP-attach to a user-launched Chrome, which is
// incompatible with unattended runs. ML lives in `scripts/scrape-ml.js` —
// see HOW_TO_SCRAP_ML.md.
//
// Args:
//   <analysis-id>                  required, copy from the UI
//   --phase=<a,b,c>                comma-separated subset of: scrape, enrich, geocode (default: all)
//   --source=<a,b,c>               comma-separated subset of: zonaprop, argenprop, remax (default: all)
//   --skip-scrape / --skip-enrich / --skip-geocode    shorthand for the inverse of --phase
//   --force                        bypass 24h enrich cooldown
//   --limit=N                      cap listings processed per (source × barrio) in enrich, default 10000
//
// Exit codes:
//   0 — finished cleanly
//   1 — bad args / analysis not found
//   2 — fatal crash during any phase

// Apply human-paced defaults BEFORE any module loads (enrich.js captures
// env values at import time). Anything the user already set wins.
function setDefault(name, value) {
  if (process.env[name] == null || process.env[name] === '') {
    process.env[name] = String(value);
  }
}
setDefault('AGENT_CONCURRENCY', 2);
// (The ML_* defaults and the --use-existing-chrome flag that used to live
// here moved to `scripts/scrape-ml.js`. MercadoLibre is handled exclusively
// by that script now — see HOW_TO_SCRAP_ML.md.)

const { getAnalysis } = await import('../src/analyses.js');
const { scrapeNeighborhood, geocodeStreamingLoop } = await import('../src/pipeline/orchestrator.js');
const { enrichListingsForSource } = await import('../src/pipeline/enrich.js');
const { readFileSync } = await import('node:fs');
const { config } = await import('../src/config.js');

// --- CLI arg parsing ---------------------------------------------------
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
  console.error('usage: node scripts/run-analysis.js <analysis-id> [--phase=…] [--source=…] [--force] [--limit=N]');
  console.error('       --phase=scrape,enrich,geocode   default: all three');
  console.error('       --source=zonaprop,argenprop,remax   default: all three');
  console.error('       --skip-scrape / --skip-enrich / --skip-geocode   shorthand');
  console.error('       --force                         bypass 24h enrich cooldown');
  console.error('       --limit=N                       cap listings/barrio in enrich (default 10000)');
  console.error('');
  console.error('  Note: MercadoLibre is handled separately by scripts/scrape-ml.js');
  console.error('        (see HOW_TO_SCRAP_ML.md). This script ignores --source=mercadolibre.');
  process.exit(1);
}
const force = flags.has('--force');
const limit = Number(opts.limit) || 10_000;

const ALL_PHASES = ['scrape', 'enrich', 'geocode'];
// MercadoLibre is intentionally NOT in this list — it needs CDP-attach to
// a user-launched Chrome, which doesn't fit the unattended/CI mode this
// script is built for. ML lives in `scripts/scrape-ml.js`; see
// HOW_TO_SCRAP_ML.md. If the user asks for --source=mercadolibre we warn
// and drop it from the run rather than silently skipping or crashing.
const ALL_SOURCES = ['zonaprop', 'argenprop', 'remax'];

function parseList(val, allowed, paramName) {
  if (val == null) return [...allowed];
  const list = String(val).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !allowed.includes(s));
  if (bad.length) {
    console.error(`[run-analysis] unknown ${paramName}: ${bad.join(', ')}`);
    console.error(`               valid values: ${allowed.join(', ')}`);
    process.exit(1);
  }
  return list;
}

let phases = parseList(opts.phase, ALL_PHASES, 'phase');
// Honor the --skip-* shorthand by removing from the phase set. Doing this
// after parsing --phase lets users combine them too (e.g. --phase=enrich
// --skip-enrich would be silly but consistent; the skip wins).
if (flags.has('--skip-scrape'))  phases = phases.filter((p) => p !== 'scrape');
if (flags.has('--skip-enrich'))  phases = phases.filter((p) => p !== 'enrich');
if (flags.has('--skip-geocode')) phases = phases.filter((p) => p !== 'geocode');

// Pre-parse --source so we can warn about ML before parseList rejects it.
const rawSources = opts.source
  ? String(opts.source).split(',').map((s) => s.trim()).filter(Boolean)
  : null;
if (rawSources?.includes('mercadolibre')) {
  console.warn('');
  console.warn('  ⚠ run-analysis.js does not handle MercadoLibre — use scripts/scrape-ml.js');
  console.warn('    (see HOW_TO_SCRAP_ML.md). Dropping mercadolibre from --source for this run.');
  console.warn('');
  const remaining = rawSources.filter((s) => s !== 'mercadolibre');
  if (remaining.length === 0) {
    console.error('[run-analysis] --source=mercadolibre was the only source — nothing else to do, exiting.');
    process.exit(1);
  }
  opts.source = remaining.join(',');
}
const sources = parseList(opts.source, ALL_SOURCES, 'source');

// --- Resolve the analysis to its neighborhoods ------------------------
const analysis = getAnalysis(analysisId);
if (!analysis) {
  console.error(`[run-analysis] analysis not found: ${analysisId}`);
  console.error('               (copy the id from the UI — "copiar id" button)');
  process.exit(1);
}

const allNeighborhoods = (() => {
  const raw = readFileSync(config.neighborhoodsPath, 'utf8');
  return JSON.parse(raw).neighborhoods || [];
})();
const targets = analysis.neighborhoods
  .map((id) => allNeighborhoods.find((n) => n.id === id))
  .filter(Boolean);

console.log('====================================================');
console.log(` Analysis: ${analysis.label}`);
console.log(` ID:       ${analysis.id}`);
console.log(` Barrios:  ${targets.map((n) => n.display).join(', ')}`);
console.log(` Phases:   ${phases.join(', ') || '(none)'}`);
console.log(` Sources:  ${sources.join(', ')}`);
console.log(` Concurrency: agent=${process.env.AGENT_CONCURRENCY}  (per-source enrich gates default 5 for zonaprop, 5 elsewhere)`);
console.log(` Limits:   force=${force} limit=${limit}/source/barrio`);
console.log('====================================================');

const t0 = Date.now();
const totals = { enriched: 0, failed: 0, gone: 0, healed: 0 };
let hadFatal = false;

for (const neighborhood of targets) {
  console.log(`\n[${new Date().toISOString()}] >>> ${neighborhood.display} (${neighborhood.id})`);

  // PHASE 1 — scrape. scrapeNeighborhood fans out to ALL sources × ops
  // internally; there is no per-source knob on it. When `--source` is a
  // strict subset, we skip the scrape phase entirely with a warning and
  // expect the user to have already scraped via the UI.
  if (phases.includes('scrape')) {
    if (sources.length !== ALL_SOURCES.length) {
      console.log(`  [scrape] skipped: --source filter is set, scrape phase is all-sources-or-none`);
    } else {
      try {
        const results = await scrapeNeighborhood(neighborhood, {
          force: !!analysis.filters?.force,
          onProgress: (p) => {
            if (p.phase === 'scrape' && p.status === 'done') return;
            if (p.source && p.status) {
              const counts = p.counts ? ` n=${p.counts.new}/+${p.counts.updated}/=${p.counts.unchanged}` : '';
              console.log(`  [scrape/${p.status}] ${p.source} · ${p.operation || ''}${counts}${p.error ? ' err=' + p.error : ''}`);
            }
          },
        });
        const t = results.reduce(
          (a, r) => ({
            new: a.new + (r.counts?.new || 0),
            updated: a.updated + (r.counts?.updated || 0),
            unchanged: a.unchanged + (r.counts?.unchanged || 0),
            failed: a.failed + (r.ok ? 0 : 1),
          }),
          { new: 0, updated: 0, unchanged: 0, failed: 0 },
        );
        console.log(`  [scrape/done] new=${t.new} updated=${t.updated} unchanged=${t.unchanged} failed_sources=${t.failed}`);
      } catch (err) {
        hadFatal = true;
        console.error(`  [scrape/crash] ${err.message}`);
      }
    }
  }

  // PHASE 2 — enrich. Per-source loop so --source filters this naturally.
  if (phases.includes('enrich')) {
    for (const source of sources) {
      // Mid-flight progress tracking — print one line every time a listing
      // STARTS or FINISHES. Cheap to do and means the user sees movement
      // every 8-25s (the ML inter-listing pause) instead of going minutes
      // without output and wondering if it's hung. Also surfaces the
      // long-break gaps so silence has a clear cause.
      const t0 = Date.now();
      let lastStarted = 0;
      let lastDone = 0;
      try {
        const result = await enrichListingsForSource({
          source,
          neighborhood: neighborhood.id,
          limit,
          force,
          onProgress: (p) => {
            if (p.status === 'starting') {
              console.log(`  [${source}/start] ${p.total ?? 0} pending`);
              return;
            }
            if (p.status === 'done') {
              const mins = ((Date.now() - t0) / 60_000).toFixed(1);
              console.log(`  [${source}/done] enriched=${p.enriched ?? 0} failed=${p.failed ?? 0} gone=${p.gone ?? 0}/${p.total ?? 0} in ${mins}min`);
              return;
            }
            const started = p.started ?? 0;
            const done = (p.enriched ?? 0) + (p.failed ?? 0) + (p.gone ?? 0);
            const total = p.total ?? '?';
            // Listing just started (started counter incremented).
            if (started > lastStarted) {
              lastStarted = started;
              const elapsedSec = ((Date.now() - t0) / 1000).toFixed(0);
              console.log(`  [${source}] ▶ started ${started}/${total} · in_flight=${p.in_flight ?? 0} · t=${elapsedSec}s`);
            }
            // Listing just finished (done counter incremented). Show what
            // bucket it landed in so the user can see failure rate building.
            if (done > lastDone) {
              const delta = done - lastDone;
              lastDone = done;
              const elapsedSec = ((Date.now() - t0) / 1000).toFixed(0);
              const okRate = done > 0 ? ((p.enriched ?? 0) / done * 100).toFixed(0) : '0';
              console.log(`  [${source}] ✓ ${done}/${total} (+${delta}) · ok=${p.enriched} fail=${p.failed} gone=${p.gone} · success=${okRate}% · t=${elapsedSec}s`);
            }
          },
        });
        if (result?.skipped) {
          console.log(`  [${source}] skipped: ${result.reason}`);
          continue;
        }
        if ((result?.enriched ?? 0) === 0 && (result?.failed ?? 0) === 0 && (result?.gone ?? 0) === 0) {
          console.log(`  [${source}] (nothing pending)`);
        }
        totals.enriched += result?.enriched ?? 0;
        totals.failed   += result?.failed   ?? 0;
        totals.gone     += result?.gone     ?? 0;
        totals.healed   += result?.healed   ?? 0;
      } catch (err) {
        hadFatal = true;
        console.error(`  [${source}/crash] ${err.message}`);
      }
    }
  }

  // PHASE 3 — geocode + sub-zone labels. Streaming loop; exits cleanly when
  // there are no pending addresses.
  if (phases.includes('geocode') && config.enableSubzones) {
    try {
      await geocodeStreamingLoop(neighborhood, {
        onProgress: (p) => {
          if (p.phase === 'subzones' && p.status === 'in_progress') {
            console.log(`  [geocode] ${neighborhood.id} geocoded=${p.geocoded} missed=${p.missed}`);
          }
        },
      });
      console.log(`  [geocode/done]`);
    } catch (err) {
      hadFatal = true;
      console.error(`  [geocode/crash] ${err.message}`);
    }
  } else if (phases.includes('geocode') && !config.enableSubzones) {
    console.log(`  [geocode] disabled (config.enableSubzones=false)`);
  }
}

const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
console.log('\n====================================================');
console.log(` Done in ${elapsedMin} min`);
console.log(` Totals: enriched=${totals.enriched} failed=${totals.failed} gone=${totals.gone} healed=${totals.healed}`);
console.log('====================================================');
process.exit(hadFatal ? 2 : 0);
