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
  for (const source of SOURCE_NAMES) {
    for (const operation of OPERATIONS) {
      const mode = decideMode(source, neighborhood, operation);
      jobs.push(
        limit(async () => {
          if (onProgress) onProgress({ source, neighborhood: neighborhood.id, operation, status: 'starting', mode });
          const result = await scrapeOne({ source, neighborhood, operation, fxRate, mode });
          if (onProgress) onProgress({ ...result, status: 'done' });
          return result;
        }),
      );
    }
  }
  const results = await Promise.all(jobs);

  // Post-scrape phase: pull richer data from the detail pages of listings
  // that the card preview didn't fully cover (Zonaprop in particular only
  // shows total OR covered, never both). Bounded so the scrape doesn't
  // balloon — see ENRICH_LIMIT.
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

  return results;
}
