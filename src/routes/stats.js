import { Router } from 'express';
import { computeStatsForNeighborhood, computeAggregate, getCellListings } from '../pipeline/stats.js';
import { getAnalysis } from '../analyses.js';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { subZoneCenter } from '../pipeline/subzone.js';

export const statsRoute = Router();

function boolParam(v, d = false) {
  if (v == null) return d;
  return v === 'true' || v === '1' || v === true;
}
function numParam(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

statsRoute.get('/', (req, res) => {
  let neighborhoods = null;
  let filters = {};

  if (req.query.analysis_id) {
    const a = getAnalysis(String(req.query.analysis_id));
    if (!a) return res.status(404).json({ error: 'analysis_not_found' });
    neighborhoods = a.neighborhoods;
    filters = a.filters;
  } else {
    const raw = String(req.query.neighborhoods || '').trim();
    if (!raw) return res.status(400).json({ error: 'neighborhoods_required' });
    neighborhoods = raw.split(',').map((s) => s.trim()).filter(Boolean);
    filters = {
      include_pozo: boolParam(req.query.include_pozo),
      include_construccion: boolParam(req.query.include_construccion),
      require_pool: boolParam(req.query.require_pool),
      require_garage: boolParam(req.query.require_garage),
      min_rooms: numParam(req.query.min_rooms),
      max_rooms: numParam(req.query.max_rooms),
      // Optional v2 sub-zone scoping. Ignored when null/empty — same behavior
      // as before.
      sub_zone: req.query.sub_zone ? String(req.query.sub_zone).trim() : null,
    };
  }
  if (!neighborhoods?.length) return res.status(400).json({ error: 'neighborhoods_required' });

  const perNeighborhood = neighborhoods.map((n) => computeStatsForNeighborhood(n, filters));
  const aggregate = neighborhoods.length > 1 ? computeAggregate(neighborhoods, filters) : null;
  res.json({ per_neighborhood: perNeighborhood, aggregate, filters });
});

// Inspector for a single matrix cell: returns the listings that went INTO the
// median (kept) and the ones excluded as premium tier, both sorted. Lets the
// user audit "why is the median that number" by hand.
statsRoute.get('/cell-listings', (req, res) => {
  const neighborhood = String(req.query.neighborhood || '').trim();
  const matrix = String(req.query.matrix || 'venta').trim(); // 'venta' | 'alquiler'
  const age = String(req.query.age || '').trim();
  const rooms = String(req.query.rooms || '').trim();
  if (!neighborhood || !age || !rooms) {
    return res.status(400).json({ error: 'neighborhood, age and rooms required' });
  }
  let filters = {};
  if (req.query.analysis_id) {
    const a = getAnalysis(String(req.query.analysis_id));
    if (!a) return res.status(404).json({ error: 'analysis_not_found' });
    filters = a.filters;
  } else {
    filters = {
      include_pozo: boolParam(req.query.include_pozo),
      include_construccion: boolParam(req.query.include_construccion),
      require_pool: boolParam(req.query.require_pool),
      require_garage: boolParam(req.query.require_garage),
      min_rooms: numParam(req.query.min_rooms),
      max_rooms: numParam(req.query.max_rooms),
    };
  }
  res.json(getCellListings({ neighborhood, matrix, age, rooms, filters }));
});

// Sub-zones v2: list of H3 cells inside a neighborhood with their auto-derived
// cross-street label and listing count. Only mounts when the feature flag is
// on; with it off the endpoint 404s and the UI hides the tab.
statsRoute.get('/subzones', (req, res) => {
  if (!config.enableSubzones) return res.status(404).json({ error: 'subzones_disabled' });
  const neighborhood = String(req.query.neighborhood || '').trim();
  if (!neighborhood) return res.status(400).json({ error: 'neighborhood_required' });
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT z.sub_zone, z.label, z.listing_count, z.computed_at
      FROM sub_zone_labels z
      WHERE z.neighborhood = ?
      ORDER BY z.listing_count DESC
    `)
    .all(neighborhood);
  const enriched = rows.map((r) => {
    const c = subZoneCenter(r.sub_zone);
    return {
      sub_zone: r.sub_zone,
      label: r.label,
      count: r.listing_count,
      center: c,
      computed_at: r.computed_at,
    };
  });
  res.json({ neighborhood, sub_zones: enriched });
});

// Background-enrich progress: how many listings still need their detail page
// pulled (m², age, address, etc.). The UI polls this while the scrape job is
// already "completed" so the user can see partial results AND know there's
// more coming.
statsRoute.get('/enrich-status', (req, res) => {
  const raw = String(req.query.neighborhoods || '').trim();
  if (!raw) return res.status(400).json({ error: 'neighborhoods_required' });
  const neighborhoods = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (neighborhoods.length === 0) return res.json({ pending: 0, total: 0, by_neighborhood: [] });
  const db = getDb();
  const ph = neighborhoods.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT neighborhood,
             COUNT(*) AS total,
             SUM(CASE WHEN enrich_attempted_at IS NULL THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN address IS NOT NULL AND lat IS NULL AND geocode_failed_at IS NULL THEN 1 ELSE 0 END) AS pending_geocode,
             SUM(CASE WHEN address IS NOT NULL AND lat IS NULL AND geocode_failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed_geocode
      FROM listings
      WHERE neighborhood IN (${ph}) AND active = 1
      GROUP BY neighborhood
    `)
    .all(...neighborhoods);
  let pendingTotal = 0;
  let total = 0;
  let pendingGeocode = 0;
  let failedGeocode = 0;
  for (const r of rows) {
    pendingTotal += r.pending || 0;
    total += r.total || 0;
    pendingGeocode += r.pending_geocode || 0;
    failedGeocode += r.failed_geocode || 0;
  }
  res.json({
    pending: pendingTotal,
    pending_geocode: config.enableSubzones ? pendingGeocode : 0,
    failed_geocode: config.enableSubzones ? failedGeocode : 0,
    total,
    by_neighborhood: rows,
  });
});

// Retry geocodes that have been marked failed. Clears `geocode_failed_at` for
// every active listing in the requested neighborhoods (or all when none are
// passed) and re-kicks `resumePendingGeocoding`. Useful after improving the
// geocoder — the user clicks the button and previously-failed addresses get
// another shot.
statsRoute.post('/retry-failed-geocoding', async (req, res) => {
  if (!config.enableSubzones) return res.status(404).json({ error: 'subzones_disabled' });
  const db = getDb();
  const raw = String(req.query.neighborhoods || '').trim();
  const neighborhoods = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  let result;
  if (neighborhoods.length > 0) {
    const ph = neighborhoods.map(() => '?').join(',');
    result = db
      .prepare(`UPDATE listings SET geocode_failed_at = NULL
                WHERE active=1 AND geocode_failed_at IS NOT NULL AND neighborhood IN (${ph})`)
      .run(...neighborhoods);
  } else {
    result = db
      .prepare(`UPDATE listings SET geocode_failed_at = NULL
                WHERE active=1 AND geocode_failed_at IS NOT NULL`)
      .run();
  }
  logger.info({ reset: result.changes, neighborhoods }, '[GEO] retry-failed-geocoding: reset rows');
  const { resumePendingGeocoding } = await import('../pipeline/orchestrator.js');
  resumePendingGeocoding().catch((err) => {
    logger.error({ err: err.message }, '[GEO] retry-failed-geocoding: resumePendingGeocoding FAILED');
  });
  res.json({ reset: result.changes });
});

// Manually kick off the sub-zones pipeline without waiting for a scrape job.
// Does two things: (1) backfills `address` from `neighborhood_raw` for ML and
// Remax listings (their card already contains the street; we just need to
// flip the column), and (2) re-starts the streaming geocoder which mints
// lat/lng + sub_zone for any listing that has an address but no coords yet.
// 404s when the feature flag is off.
statsRoute.post('/run-geocoding', async (req, res) => {
  logger.info('[GEO] /run-geocoding endpoint called');
  if (!config.enableSubzones) {
    logger.warn('[GEO] feature flag enableSubzones=false — 404');
    return res.status(404).json({ error: 'subzones_disabled' });
  }
  const db = getDb();

  // Snapshot BEFORE
  const before = db
    .prepare(`
      SELECT SUM(CASE WHEN address IS NOT NULL AND lat IS NULL THEN 1 ELSE 0 END) AS pending_geocode,
             SUM(CASE WHEN address IS NOT NULL THEN 1 ELSE 0 END) AS with_addr,
             SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) AS with_geo
      FROM listings WHERE active = 1
    `)
    .get();
  logger.info({ before }, '[GEO] snapshot BEFORE');

  // NOTE: we no longer backfill address from neighborhood_raw. ML and Remax
  // both extract the canonical address from the detail page in their
  // enrichDetail now (cleaner than the card-level seller-typed garbage that
  // neighborhood_raw used to give us). This endpoint only kicks the geocode
  // loop for addresses already populated by the enricher.
  const result = { changes: 0 };
  logger.info('[GEO] skipping backfill (handled in enrichDetail now)');

  // Snapshot AFTER backfill
  const afterBackfill = db
    .prepare(`
      SELECT SUM(CASE WHEN address IS NOT NULL AND lat IS NULL THEN 1 ELSE 0 END) AS pending_geocode,
             SUM(CASE WHEN address IS NOT NULL THEN 1 ELSE 0 END) AS with_addr
      FROM listings WHERE active = 1
    `)
    .get();
  logger.info({ afterBackfill }, '[GEO] snapshot AFTER backfill');

  // Per-neighborhood pending counts so we see exactly what should be processed
  const pendingByN = db
    .prepare(`
      SELECT neighborhood, COUNT(*) AS pending FROM listings
      WHERE active=1 AND address IS NOT NULL AND lat IS NULL
      GROUP BY neighborhood ORDER BY pending DESC LIMIT 10
    `)
    .all();
  logger.info({ topPending: pendingByN }, '[GEO] top neighborhoods with pending addresses');

  // (2) kick the streaming geocode loop for every neighborhood that still
  // has pending addresses. The loop is mutex'd by neighborhood.
  logger.info('[GEO] calling resumePendingGeocoding()...');
  const { resumePendingGeocoding } = await import('../pipeline/orchestrator.js');
  resumePendingGeocoding()
    .then(() => logger.info('[GEO] resumePendingGeocoding() returned'))
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, '[GEO] resumePendingGeocoding FAILED');
    });

  res.json({
    backfilled: result.changes,
    pending_geocode: afterBackfill.pending_geocode || 0,
    with_addr: afterBackfill.with_addr || 0,
    message: `${result.changes} addresses backfilled; geocoder loop started`,
  });
});
