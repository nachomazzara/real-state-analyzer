import pLimit from 'p-limit';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getMepRate } from '../fx.js';
import { normalize, isValid } from './normalize.js';
import { upsertListing, getCursor, upsertCursor, markStaleInactive } from './persist.js';
import { enrichAfterScrape } from './enrich.js';

import * as mercadolibre from '../scrapers/mercadolibre.js';
import * as argenprop from '../scrapers/argenprop.js';
import * as remax from '../scrapers/remax.js';
import * as zonaprop from '../scrapers/zonaprop.js';

const ALL_SCRAPERS = {
  mercadolibre,
  argenprop,
  remax,
  zonaprop,
};

// Comma-separated env var to disable specific sources at runtime. Useful when
// a source's anti-bot wall is up (mercadolibre on a flagged IP) — set
// DISABLED_SOURCES=mercadolibre and the orchestrator/enricher skip it.
const DISABLED = new Set(
  (process.env.DISABLED_SOURCES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const SCRAPERS = Object.fromEntries(
  Object.entries(ALL_SCRAPERS).filter(([name]) => !DISABLED.has(name)),
);

const OPERATIONS = ['venta', 'alquiler'];
const SOURCE_NAMES = Object.keys(SCRAPERS);

async function scrapeOne({ source, neighborhood, operation, fxRate, mode }) {
  const scraper = SCRAPERS[source];
  const startedAt = Date.now();
  const counts = { new: 0, updated: 0, unchanged: 0, skipped: 0, total: 0 };
  let consecutiveUnchanged = 0;
  let stoppedEarly = false;

  try {
    for await (const { page, listings } of scraper.iterateListings(neighborhood, operation)) {
      for (const raw of listings) {
        counts.total++;
        const normalized = normalize(raw, fxRate);
        if (!isValid(normalized)) {
          counts.skipped++;
          continue;
        }
        const res = upsertListing(normalized);
        if (res.state === 'new') {
          counts.new++;
          consecutiveUnchanged = 0;
        } else if (res.state === 'updated') {
          counts.updated++;
          consecutiveUnchanged = 0;
        } else {
          counts.unchanged++;
          consecutiveUnchanged++;
        }

        if (mode === 'incremental' && consecutiveUnchanged >= config.incrementalStopAfter) {
          stoppedEarly = true;
          break;
        }
      }
      if (stoppedEarly) break;
      logger.info(
        { source, neighborhood: neighborhood.id, operation, page, counts },
        'page processed',
      );
    }

    if (mode === 'full') {
      // Safety: if a "full" scrape came back nearly empty (≤5 listings),
      // it almost certainly hit a bot wall / network error rather than the
      // listings genuinely disappearing. Don't deactivate the existing pool
      // based on a broken scrape — that erases real data.
      const SAFETY_FLOOR = 5;
      let deactivated = 0;
      if (counts.total > SAFETY_FLOOR) {
        deactivated = markStaleInactive(source, neighborhood.id, operation, startedAt);
      } else {
        logger.warn(
          { source, neighborhood: neighborhood.id, operation, scraped: counts.total },
          'full scrape returned too few results — skipping stale-inactive sweep to avoid nuking real data',
        );
      }
      counts.deactivated = deactivated;
      upsertCursor({
        source,
        neighborhood: neighborhood.id,
        operation,
        lastFullScrapeAt: Date.now(),
        lastIncrementalScrapeAt: Date.now(),
        lastKnownTotal: counts.total,
      });
    } else {
      upsertCursor({
        source,
        neighborhood: neighborhood.id,
        operation,
        lastIncrementalScrapeAt: Date.now(),
      });
    }

    return { ok: true, source, neighborhood: neighborhood.id, operation, mode, counts, stoppedEarly };
  } catch (err) {
    logger.warn(
      { err: err.message, source, neighborhood: neighborhood.id, operation },
      'scrape source failed',
    );
    return {
      ok: false,
      source,
      neighborhood: neighborhood.id,
      operation,
      mode,
      counts,
      error: err.message,
    };
  }
}

function decideMode(source, neighborhood, operation) {
  const cur = getCursor(source, neighborhood.id, operation);
  if (!cur || !cur.last_full_scrape_at) return 'full';
  const ageMs = Date.now() - cur.last_full_scrape_at;
  const fullThresh = config.fullRefreshDays * 24 * 3600 * 1000;
  return ageMs > fullThresh ? 'full' : 'incremental';
}

export async function scrapeSingleTarget({ source, neighborhood, operation, mode = 'full', onProgress } = {}) {
  if (!SCRAPERS[source]) throw new Error(`unknown source ${source}`);
  if (!OPERATIONS.includes(operation)) throw new Error(`unknown operation ${operation}`);
  const fxRate = await getMepRate();
  if (onProgress) onProgress({ source, neighborhood: neighborhood.id, operation, status: 'starting', mode });
  const result = await scrapeOne({ source, neighborhood, operation, fxRate, mode });
  if (onProgress) onProgress({ ...result, status: 'done' });
  return result;
}

export async function scrapeNeighborhood(neighborhood, { onProgress, force = false } = {}) {
  const fxRate = await getMepRate();
  const limit = pLimit(Math.max(1, config.maxConcurrency));
  const jobs = [];
  // ML cookies are shared across every ML job in this neighborhood — if they
  // expire mid-run the first job to notice trips this breaker and the rest
  // skip immediately instead of repeating the same failed login.
  let mlAuthBroken = false;
  for (const source of SOURCE_NAMES) {
    for (const operation of OPERATIONS) {
      const mode = decideMode(source, neighborhood, operation);
      jobs.push(
        limit(async () => {
          if (source === 'mercadolibre' && mlAuthBroken) {
            const skipped = { ok: false, source, neighborhood: neighborhood.id, operation, mode, counts: { new: 0, updated: 0, unchanged: 0, skipped: 0, total: 0 }, error: 'skipped: ML auth broken earlier in run' };
            if (onProgress) onProgress({ ...skipped, status: 'done' });
            return skipped;
          }
          if (onProgress) onProgress({ source, neighborhood: neighborhood.id, operation, status: 'starting', mode });
          const result = await scrapeOne({ source, neighborhood, operation, fxRate, mode });
          if (source === 'mercadolibre' && !result.ok && /MercadoLibreAuthError|cookies likely expired/i.test(result.error || '')) {
            if (!mlAuthBroken) {
              mlAuthBroken = true;
              logger.error(
                { neighborhood: neighborhood.id, operation },
                'MercadoLibre auth failed — skipping remaining ML jobs in this neighborhood. Refresh data/ml-cookies.txt and re-run.',
              );
            }
          }
          if (onProgress) onProgress({ ...result, status: 'done' });
          return result;
        }),
      );
    }
  }
  const results = await Promise.all(jobs);
  if (onProgress) onProgress({ phase: 'scrape', neighborhood: neighborhood.id, status: 'done' });

  // Post-scrape phases (enrich + sub-zones) used to block here. They take
  // long enough — especially with ML's human-like cadence — that the user
  // would stare at a spinner for hours before seeing results. Now they run
  // in the background after the orchestrator returns: the job marks itself
  // completed as soon as the scrape is done, the UI loads the partial data
  // it already has, and the background work keeps filling in m²/age/address
  // as it lands. The UI polls /api/enrich-status to show pending counts.
  runBackgroundEnrich(neighborhood, { onProgress, force }).catch((err) => {
    logger.warn({ err: err.message, neighborhood: neighborhood.id }, 'background enrich crashed');
  });

  return results;
}

// Background tail: enrich + (optional) sub-zones running IN PARALLEL. The
// geocode loop streams off the same DB as enrich, so as soon as the enricher
// lands a fresh address it gets picked up on the next geocode iteration —
// the user sees sub-zone labels appearing within minutes instead of waiting
// for enrich to fully finish (which can be hours on ML). Exceptions are
// caught and logged so neither phase can poison the scrape job's state.
async function runBackgroundEnrich(neighborhood, { onProgress, force } = {}) {
  const enrichPromise = (async () => {
    try {
      const enrichResult = await enrichAfterScrape(neighborhood, {
        onProgress,
        limitPerSource: Number(process.env.ENRICH_LIMIT) || 10000,
        force,
      });
      if (onProgress) onProgress({ phase: 'enrich', neighborhood: neighborhood.id, result: enrichResult, status: 'done' });
    } catch (err) {
      logger.warn({ err: err.message }, 'enrich phase failed (non-fatal)');
    }
  })();
  // Geocode + label loop runs CONCURRENTLY with enrich (gated by feature
  // flag). It polls for newly-arrived addresses and processes them in small
  // batches, recomputing labels after each batch so the UI updates quickly.
  const geocodePromise = config.enableSubzones
    ? geocodeStreamingLoop(neighborhood, { onProgress }).catch((err) => {
        logger.warn({ err: err.message }, 'geocode loop failed (non-fatal)');
      })
    : Promise.resolve();
  await Promise.all([enrichPromise, geocodePromise]);
}

// Per-neighborhood guard: at most one geocode loop runs per neighborhood at
// any time. A second caller (background enrich + startup auto-resume, or two
// scrape jobs landing close together) attaches to the same in-flight promise
// instead of spawning a parallel loop that would fight for the same rows.
const runningGeocodeLoops = new Map();

export function geocodeStreamingLoop(neighborhood, opts = {}) {
  const key = neighborhood.id;
  if (runningGeocodeLoops.has(key)) {
    logger.info({ neighborhood: key }, '[GEO-LOOP] already running, attaching to existing promise');
    return runningGeocodeLoops.get(key);
  }
  logger.info({ neighborhood: key }, '[GEO-LOOP] starting new loop');
  const promise = runGeocodeStreamingLoop(neighborhood, opts).finally(() => {
    runningGeocodeLoops.delete(key);
    logger.info({ neighborhood: key }, '[GEO-LOOP] cleanup: mutex released');
  });
  runningGeocodeLoops.set(key, promise);
  return promise;
}

// Streaming geocoder. Pulls up to BATCH addresses with no lat/lng, geocodes
// them, recomputes labels. Exits when there are no pending geocodes for
// IDLE_EXIT_CHECKS consecutive idle waits — that way the loop can run on its
// own (no enrich required) and still terminate cleanly when there's nothing
// left to do. While enrich IS running it produces new addresses faster than
// the idle-counter can advance, so the loop keeps going.
async function runGeocodeStreamingLoop(neighborhood, { onProgress } = {}) {
  const { getDb } = await import('../db.js');
  const { geocode } = await import('./geocode.js');
  const { computeSubZone } = await import('./subzone.js');
  const { recomputeLabelsForNeighborhood } = await import('./subzone-labels.js');
  const { default: pLimit } = await import('p-limit');
  const db = getDb();
  const BATCH = 50;
  // USIG has no documented rate limit, so we can fire several requests in
  // parallel within a batch. Nominatim is gated globally to 1.1s in
  // geocode.js — those calls naturally serialize behind the gate. Net effect:
  // USIG hits go ~8x faster, Nominatim hits stay at 1/s.
  const GEO_CONCURRENCY = Number(process.env.GEO_CONCURRENCY) || 8;
  const inFlight = pLimit(GEO_CONCURRENCY);
  // Zonaprop map-coord fallback runs Playwright per call (~10-15s, hits
  // Cloudflare-walled detail pages). Cap at 2 concurrent so we don't melt
  // the shared Chrome context or trip Cloudflare's rate limits. Most
  // listings won't need this — text geocoding handles the common case.
  const mapFallbackInFlight = pLimit(Number(process.env.ZONAPROP_MAP_FALLBACK_CONCURRENCY) || 2);
  const IDLE_SLEEP_MS = 15_000;
  const IDLE_EXIT_CHECKS = 2; // ≈ 30s of "nothing to do" before exiting
  let totalGeocoded = 0;
  let totalMissed = 0;
  let idleChecks = 0;
  let iteration = 0;
  logger.info({ neighborhood: neighborhood.id }, '[GEO-LOOP] runGeocodeStreamingLoop entered');
  while (true) {
    iteration++;
    const pending = db
      .prepare(`
        SELECT id, source, url, address FROM listings
        WHERE active=1 AND neighborhood=? AND address IS NOT NULL AND lat IS NULL
              AND geocode_failed_at IS NULL
        LIMIT ?
      `)
      .all(neighborhood.id, BATCH);
    logger.info(
      { neighborhood: neighborhood.id, iteration, batchSize: pending.length, totalGeocoded, totalMissed, idleChecks },
      '[GEO-LOOP] batch fetched',
    );
    if (pending.length === 0) {
      idleChecks++;
      logger.info({ neighborhood: neighborhood.id, idleChecks }, '[GEO-LOOP] empty batch — idle check');
      if (idleChecks >= IDLE_EXIT_CHECKS) {
        const labels = recomputeLabelsForNeighborhood(neighborhood.id);
        if (onProgress) {
          onProgress({
            phase: 'subzones',
            neighborhood: neighborhood.id,
            result: { geocoded: totalGeocoded, missed: totalMissed, ...labels },
            status: 'done',
          });
        }
        logger.info(
          { neighborhood: neighborhood.id, geocoded: totalGeocoded, missed: totalMissed, ...labels },
          '[GEO-LOOP] DRAINED — exiting',
        );
        return;
      }
      await new Promise((res) => setTimeout(res, IDLE_SLEEP_MS));
      continue;
    }
    idleChecks = 0;
    let batchGeocoded = 0;
    let batchMissed = 0;
    // Process the batch in parallel under the inFlight gate. USIG calls (the
    // fast path, most addresses) run truly concurrent; Nominatim fallbacks
    // serialize behind their own 1.1s global gate in geocode.js. SQLite
    // writes happen one row at a time (better-sqlite3 is sync) so no
    // contention there.
    await Promise.all(pending.map((row) => inFlight(async () => {
      let result = await geocode(row.address);
      let source = result?.source ?? null;
      let normalized = result?.normalized ?? null;
      // Zonaprop map-coord fallback: when the text geocoder gives up on a
      // Zonaprop listing, the detail page's map widget still has the exact
      // lat/lng (Zonaprop server-renders coords into Google Maps anchors
      // when the modal mounts). Click + parse — ground truth, beats any
      // text heuristic. Other sources (ML/Argenprop/Remax) stay text-only
      // for now.
      if (!result && row.source === 'zonaprop' && row.url) {
        try {
          const { fetchMapCoords } = await import('../scrapers/zonaprop.js');
          const coords = await mapFallbackInFlight(() => fetchMapCoords(row.url));
          if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
            result = { lat: coords.lat, lng: coords.lng };
            source = 'zonaprop-map';
            normalized = `map@${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`;
            logger.info(
              { neighborhood: neighborhood.id, id: row.id, url: row.url, lat: coords.lat, lng: coords.lng },
              '[GEO-LOOP] recovered via zonaprop map widget',
            );
          }
        } catch (err) {
          logger.warn({ id: row.id, url: row.url, err: err.message }, '[GEO-LOOP] zonaprop map fallback failed');
        }
      }
      if (!result) {
        // Mark as failed so subsequent loops skip it. The UI provides a
        // "reintentar fallidos" button that clears this flag when the user
        // wants to retry (e.g. after improving the geocoder).
        db.prepare('UPDATE listings SET geocode_failed_at=? WHERE id=?').run(Date.now(), row.id);
        totalMissed++;
        batchMissed++;
        if (batchMissed <= 3) {
          logger.warn({ neighborhood: neighborhood.id, id: row.id, address: row.address }, '[GEO-LOOP] geocode returned null');
        }
        return;
      }
      const subzone = computeSubZone(result.lat, result.lng);
      db.prepare(`
        UPDATE listings SET lat=?, lng=?, address_normalized=?, sub_zone=?
        WHERE id=?
      `).run(result.lat, result.lng, normalized, subzone, row.id);
      totalGeocoded++;
      batchGeocoded++;
    })));
    logger.info(
      { neighborhood: neighborhood.id, iteration, batchGeocoded, batchMissed, totalGeocoded, totalMissed },
      '[GEO-LOOP] batch done',
    );
    recomputeLabelsForNeighborhood(neighborhood.id);
    if (onProgress) {
      onProgress({
        phase: 'subzones',
        neighborhood: neighborhood.id,
        geocoded: totalGeocoded,
        missed: totalMissed,
        status: 'in_progress',
      });
    }
  }
}

// Server-startup hook: scan the DB for neighborhoods that already have
// addresses waiting to be geocoded (e.g. left over from a previous run, or
// inserted via a one-shot SQL backfill) and kick off the streaming loop for
// each. This way the user doesn't have to start a fresh scrape just to make
// pending geocoding progress.
export async function resumePendingGeocoding() {
  logger.info('[GEO] resumePendingGeocoding called');
  if (!config.enableSubzones) {
    logger.warn('[GEO] resumePendingGeocoding: enableSubzones=false, returning');
    return;
  }
  const { getDb } = await import('../db.js');
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT neighborhood, COUNT(*) AS pending FROM listings
      WHERE active=1 AND address IS NOT NULL AND lat IS NULL
            AND geocode_failed_at IS NULL
      GROUP BY neighborhood
      HAVING pending > 0
    `)
    .all();
  if (rows.length === 0) {
    logger.info('[GEO] resumePendingGeocoding: 0 neighborhoods with pending — no-op');
    return;
  }
  logger.info({ count: rows.length, total: rows.reduce((a, r) => a + r.pending, 0), perNeighborhood: rows }, '[GEO] resumePendingGeocoding: spawning loops');
  for (const r of rows) {
    logger.info({ neighborhood: r.neighborhood, pending: r.pending }, '[GEO] spawning loop for neighborhood');
    geocodeStreamingLoop({ id: r.neighborhood }).catch((err) => {
      logger.error({ err: err.message, stack: err.stack, neighborhood: r.neighborhood }, '[GEO] loop CRASHED');
    });
  }
}
