import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db.js';
import { createTargetedJob, createEnrichPendingJob } from '../jobs.js';

export const sourcesRoute = Router();

// MercadoLibre is intentionally OUT of this list. ML's anti-bot fingerprints
// the Playwright-launched Chrome and walls ~90% of requests; the only
// reliable path is to attach via CDP to the user's own Chrome, which needs
// manual setup (relaunch with --remote-debugging-port=9222). That's
// incompatible with one-click UI flows, so ML lives in `scripts/scrape-ml.js`
// — see HOW_TO_SCRAP_ML.md. ML listings already in the DB stay visible in
// stats/ranking; we just stop offering "refresh" / "enrich" buttons for them.
const SOURCES = ['argenprop', 'remax', 'zonaprop'];
const OPERATIONS = ['venta', 'alquiler'];

sourcesRoute.get('/', (req, res) => {
  const db = getDb();
  const raw = String(req.query.neighborhoods || '').trim();
  const neighborhoods = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;

  // For each (source, neighborhood, operation), report:
  //   - total listings active
  //   - inactive listings count
  //   - last_seen_at (max)
  //   - cursor last_full_scrape_at and last_incremental_scrape_at
  const whereExtra = neighborhoods ? `AND neighborhood IN (${neighborhoods.map(() => '?').join(',')})` : '';

  // Two views of "needs enrichment":
  //   incomplete_total: every active listing missing covered_m2/total_m2/age.
  //     Always shown so the user knows the universe of work pending.
  //   pending_enrich: those plus a 24h cooldown — eligible for retry RIGHT
  //     NOW. The retry button uses this so we don't spam re-fetches of the
  //     same listings every poll.
  const retryCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const aggSql = `
    SELECT source, neighborhood, operation,
      SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS inactive_count,
      SUM(CASE WHEN active = 1
                 AND (
                   covered_m2 IS NULL OR age_years IS NULL OR total_m2 IS NULL
                   OR enrich_attempted_at IS NULL
                 )
              THEN 1 ELSE 0 END) AS incomplete_total,
      SUM(CASE WHEN active = 1
                 AND (
                   covered_m2 IS NULL OR age_years IS NULL OR total_m2 IS NULL
                   OR enrich_attempted_at IS NULL
                 )
                 AND (enrich_attempted_at IS NULL OR enrich_attempted_at < ${retryCutoff})
              THEN 1 ELSE 0 END) AS pending_enrich,
      MAX(last_seen_at) AS last_seen_at,
      MIN(first_seen_at) AS first_seen_at
    FROM listings
    WHERE 1 = 1 ${whereExtra}
    GROUP BY source, neighborhood, operation
  `;
  const agg = db.prepare(aggSql).all(...(neighborhoods || []));

  const cursorSql = `
    SELECT source, neighborhood, operation, last_full_scrape_at, last_incremental_scrape_at, last_known_total
    FROM source_cursors
    WHERE 1 = 1 ${whereExtra}
  `;
  const cursors = db.prepare(cursorSql).all(...(neighborhoods || []));
  const cursorMap = new Map();
  for (const c of cursors) {
    cursorMap.set(`${c.source}|${c.neighborhood}|${c.operation}`, c);
  }

  const aggMap = new Map();
  for (const a of agg) {
    aggMap.set(`${a.source}|${a.neighborhood}|${a.operation}`, a);
  }

  // Build the matrix: even when there is no data yet, include a row per
  // (source × neighborhood × operation) the user requested.
  const targetNeighborhoods =
    neighborhoods ||
    [...new Set([...agg.map((a) => a.neighborhood), ...cursors.map((c) => c.neighborhood)])];

  const out = [];
  for (const n of targetNeighborhoods) {
    for (const source of SOURCES) {
      for (const operation of OPERATIONS) {
        const k = `${source}|${n}|${operation}`;
        const a = aggMap.get(k) || {};
        const c = cursorMap.get(k) || {};
        out.push({
          source,
          neighborhood: n,
          operation,
          active_count: a.active_count || 0,
          inactive_count: a.inactive_count || 0,
          incomplete_total: a.incomplete_total || 0,
          pending_enrich: a.pending_enrich || 0,
          first_seen_at: a.first_seen_at || null,
          last_seen_at: a.last_seen_at || null,
          last_full_scrape_at: c.last_full_scrape_at || null,
          last_incremental_scrape_at: c.last_incremental_scrape_at || null,
          last_known_total: c.last_known_total || null,
        });
      }
    }
  }

  res.json({ sources: out });
});

// Same allow-list as SOURCES above. ML is rejected by both POST endpoints
// below because it's CLI-only — see HOW_TO_SCRAP_ML.md.
const RefreshBody = z.object({
  source: z.enum(['argenprop', 'remax', 'zonaprop']),
  neighborhood: z.string().min(1),
  operation: z.enum(['venta', 'alquiler']),
  mode: z.enum(['full', 'incremental']).optional(),
});

// Explicit ML rejection. zod's enum mismatch would also reject it, but with
// a generic "invalid_body" message — this gives the caller (and any human
// hitting the endpoint directly) the actionable pointer.
function rejectIfML(req, res) {
  if (req.body?.source === 'mercadolibre') {
    res.status(400).json({
      error: 'ml_handled_via_cli',
      message: 'MercadoLibre is no longer triggered from the UI. See HOW_TO_SCRAP_ML.md and run `node --env-file=.env scripts/scrape-ml.js <analysis-id>` instead.',
    });
    return true;
  }
  return false;
}

sourcesRoute.post('/refresh', (req, res) => {
  if (rejectIfML(req, res)) return;
  const parsed = RefreshBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const job = createTargetedJob(parsed.data);
  res.json({ job_id: job.id, started_at: job.started_at });
});

const EnrichPendingBody = z.object({
  source: z.enum(['argenprop', 'remax', 'zonaprop']),
  neighborhood: z.string().min(1),
  force: z.boolean().optional().default(true),
});

// Inspector: list the actual rows that show up in the pending_enrich count.
// Lets the user audit whether the source is really missing the data or whether
// our parser is at fault.
sourcesRoute.get('/pending-listings', (req, res) => {
  const source = String(req.query.source || '');
  const neighborhood = String(req.query.neighborhood || '');
  if (!source || !neighborhood) return res.status(400).json({ error: 'source_and_neighborhood_required' });
  const retryCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = getDb()
    .prepare(
      `SELECT id, external_id, url, operation, status, price, currency, covered_m2,
              uncovered_m2, total_m2, homogenized_m2, age_years, rooms, enrich_attempted_at
       FROM listings
       WHERE source = ? AND neighborhood = ? AND active = 1
         AND (
           covered_m2 IS NULL OR age_years IS NULL OR total_m2 IS NULL
           OR enrich_attempted_at IS NULL
         )
         AND (enrich_attempted_at IS NULL OR enrich_attempted_at < ?)
       ORDER BY last_seen_at DESC
       LIMIT 100`,
    )
    .all(source, neighborhood, retryCutoff);
  // Also include the recently-attempted ones (so user understands why pending=N).
  const attempted = getDb()
    .prepare(
      `SELECT id, external_id, url, operation, covered_m2, age_years, total_m2, enrich_attempted_at
       FROM listings
       WHERE source = ? AND neighborhood = ? AND active = 1
         AND (covered_m2 IS NULL OR age_years IS NULL OR total_m2 IS NULL)
         AND enrich_attempted_at >= ?
       ORDER BY enrich_attempted_at DESC
       LIMIT 50`,
    )
    .all(source, neighborhood, retryCutoff);
  res.json({ pending: rows, recently_attempted: attempted });
});

sourcesRoute.post('/enrich-pending', (req, res) => {
  if (rejectIfML(req, res)) return;
  const parsed = EnrichPendingBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const job = createEnrichPendingJob(parsed.data);
  res.json({ job_id: job.id, started_at: job.started_at, force: parsed.data.force });
});
