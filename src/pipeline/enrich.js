import pLimit from 'p-limit';
import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { homogenize, ageBand } from './homogenize.js';
import { classifyStatus, parseFinancedPrice } from './filter.js';
import { getMepRate, toUsd } from '../fx.js';
import { enrichDetail as enrichZonaprop } from '../scrapers/zonaprop.js';
import { enrichDetail as enrichRemax } from '../scrapers/remax.js';
import { enrichDetail as enrichArgenprop } from '../scrapers/argenprop.js';
import { enrichDetail as enrichMercadolibre } from '../scrapers/mercadolibre.js';
import { runSkill } from '../agent.js';

const ALL_ENRICHERS = {
  zonaprop: enrichZonaprop,
  remax: enrichRemax,
  argenprop: enrichArgenprop,
  mercadolibre: enrichMercadolibre,
};
// Honour DISABLED_SOURCES so the scrape orchestrator and the enricher agree
// on which sources to skip.
const DISABLED = new Set(
  (process.env.DISABLED_SOURCES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const ENRICHERS = Object.fromEntries(
  Object.entries(ALL_ENRICHERS).filter(([name]) => !DISABLED.has(name)),
);

// Process both venta AND alquiler — we need accurate cubierta/total for both
// (so rentals contribute to correctly homogenized comparables).
// `enrich_attempted_at` keeps us from re-fetching the same listing every poll
// when the source simply doesn't expose the missing fields. Re-attempt after
// ENRICH_RETRY_AFTER_MS (default 24h).
const ENRICH_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const SELECT_INCOMPLETE_BASE = `
  SELECT id, source, url, operation, status, price, currency, price_usd,
         covered_m2, uncovered_m2, total_m2, age_years, rooms, delivery_year,
         has_garage, has_pool, has_amenities
  FROM listings
  WHERE source = ? AND neighborhood = ? AND active = 1
    AND (
      covered_m2 IS NULL OR age_years IS NULL OR total_m2 IS NULL
      OR enrich_attempted_at IS NULL
    )
`;
const SELECT_INCOMPLETE_COOLDOWN = SELECT_INCOMPLETE_BASE +
  '  AND (enrich_attempted_at IS NULL OR enrich_attempted_at < ?)\n' +
  '  ORDER BY last_seen_at DESC\n  LIMIT ?\n';
const SELECT_INCOMPLETE_FORCE = SELECT_INCOMPLETE_BASE +
  '  ORDER BY last_seen_at DESC\n  LIMIT ?\n';
const MARK_ATTEMPTED = `UPDATE listings SET enrich_attempted_at = ? WHERE id = ?`;

const UPDATE_STATUS_PRICE = `
  UPDATE listings SET status = ?, price = ?, currency = ?, price_usd = ?, delivery_year = ?
  WHERE id = ?
`;

const UPDATE_ENRICHED = `
  UPDATE listings SET
    covered_m2 = COALESCE(?, covered_m2),
    uncovered_m2 = COALESCE(?, uncovered_m2),
    total_m2 = COALESCE(?, total_m2),
    homogenized_m2 = ?,
    rooms = COALESCE(?, rooms),
    bedrooms = COALESCE(?, bedrooms),
    bathrooms = COALESCE(?, bathrooms),
    has_garage = ?,
    has_pool = ?,
    has_amenities = ?,
    age_years = COALESCE(?, age_years),
    age_band = COALESCE(?, age_band),
    floor = COALESCE(?, floor),
    last_seen_at = ?
  WHERE id = ?
`;

// Detect floor from free text. Handles "Piso 5", "5° piso", "segundo piso",
// "Planta Baja"/"PB", "duplex" annotation. Returns a normalized string.
function extractFloorFromText(text) {
  if (!text) return null;
  const s = String(text);
  let m = s.match(/\bpiso\s*[nº°#:]?\s*(\d{1,3})\b/i);
  if (m) return m[1];
  m = s.match(/\b(\d{1,3})\s*[°º]\s*piso\b/i);
  if (m) return m[1];
  const words = {
    primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3, cuarto: 4,
    quinto: 5, sexto: 6, séptimo: 7, septimo: 7, octavo: 8, noveno: 9, décimo: 10, decimo: 10,
  };
  for (const [word, n] of Object.entries(words)) {
    const re = new RegExp(`\\b${word}\\s+piso\\b`, 'i');
    if (re.test(s)) return String(n);
  }
  if (/\bplanta\s+baja\b/i.test(s) || /\bP\.?B\.?\b/.test(s)) return 'PB';
  if (/\bPH\b/.test(s)) return 'PH';
  if (/\bd[uú]plex\b/i.test(s)) return 'duplex';
  return null;
}

async function escalateToAgent(row, source) {
  const missing = [];
  if (row.age_years == null) missing.push('age_years');
  if (row.covered_m2 == null) missing.push('covered_m2');
  if (row.total_m2 == null) missing.push('total_m2');
  if (row.rooms == null) missing.push('rooms');
  try {
    return await runSkill({
      skill: 'extract-listing-fields',
      vars: { URL: row.url, SOURCE: source, FIELDS: missing.join(',') },
      timeoutMs: 150_000,
    });
  } catch (err) {
    logger.warn({ url: row.url, err: err.message }, 'auto-heal agent failed');
    return null;
  }
}

// Enrich up to `limit` listings of `source` in `neighborhood` by visiting
// their detail page. Default is unlimited (10000) — the user explicitly asked
// for completeness over speed. Falls back to a Claude agent when the direct
// extractor returns nothing useful.
//
// `force=true` bypasses the 24h `enrich_attempted_at` cooldown so the user can
// re-attempt every incomplete listing on demand. Used by the manual "refresh"
// buttons in the UI.
export async function enrichListingsForSource({ source, neighborhood, limit = 10000, onProgress, useAgentFallback = true, force = false }) {
  const enricher = ENRICHERS[source];
  if (!enricher) return { skipped: true, reason: 'no enricher for ' + source };

  const db = getDb();
  // `force` skips the 24h `enrich_attempted_at` cooldown so the user can
  // re-run enrichment over every incomplete listing on demand.
  const rows = force
    ? db.prepare(SELECT_INCOMPLETE_FORCE).all(source, neighborhood, limit)
    : db
        .prepare(SELECT_INCOMPLETE_COOLDOWN)
        .all(source, neighborhood, Date.now() - ENRICH_RETRY_AFTER_MS, limit);
  if (rows.length === 0) return { enriched: 0 };

  // Fetch the FX rate once so all currency conversions during this enrich
  // batch share the same number (cached for 1h anyway).
  let fxRate = null;
  try {
    fxRate = await getMepRate();
  } catch (err) {
    logger.warn({ err: err.message }, 'enrich: could not load fx rate, USD-only listings unaffected');
  }

  let enriched = 0;
  let failed = 0;
  let healed = 0;
  let gone = 0;
  let started = 0;
  let inFlight = 0;
  let agentInFlight = 0;
  const totalCount = rows.length;
  if (onProgress) {
    onProgress({ phase: 'enrich', source, neighborhood, status: 'starting', total: totalCount });
  }
  // Emit progress on every state change. The UI polls every ~1.5s so coalesce
  // bursts to one event per ~400ms (don't push thousands), but the start/end
  // of long agent calls always reaches the user because in_flight changes.
  let lastEmitAt = 0;
  let emitTimer = null;
  function emitProgress(force = false) {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmitAt < 400) {
      // Schedule a trailing emit so the LAST state change in a burst gets
      // through. Without this, the final increment can be hidden under the
      // 400ms cooldown and the user sees stale numbers.
      if (!emitTimer) emitTimer = setTimeout(() => emitProgress(true), 450);
      return;
    }
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    lastEmitAt = now;
    onProgress({
      phase: 'enrich',
      source,
      neighborhood,
      status: 'running',
      enriched,
      failed,
      gone,
      started,
      in_flight: inFlight,
      agent_in_flight: agentInFlight,
      total: totalCount,
    });
  }
  // Process listings concurrently per source. MercadoLibre is special: a
  // bot-detection wall trips when too many detail requests come from the
  // same IP in quick succession, so we throttle ML to a single in-flight
  // request and pause between them.
  // Start with 2 concurrent ML fetches and a short delay. If ML behaves we
  // can raise this in .env via ML_ENRICH_CONCURRENCY without code changes.
  const ML_CONCURRENCY = Number(process.env.ML_ENRICH_CONCURRENCY) || 8;
  // No throttle by default: refreshMlCookies() resets the session before each
  // navigation so ML can't link rapid-fire requests to a single bot session.
  // Throttle was protective when we shared cookies across requests.
  const ML_INTER_REQUEST_MS = Number(process.env.ML_ENRICH_DELAY_MS) || 0;
  // Zonaprop sits behind Cloudflare Turnstile. Parallel detail-page hits
  // trigger fresh challenges that don't resolve without user interaction —
  // so 1 concurrent + a delay between requests is the sweet spot. Anything
  // that still gets walled falls through to the agent.
  const ZP_CONCURRENCY = Number(process.env.ZONAPROP_ENRICH_CONCURRENCY) || 5;
  // Inter-request delay for zonaprop. Defaults to 0 now that we clear
  // cookies before every detail-page navigation — Cloudflare treats each
  // request as a fresh session, so throttling between them serves no
  // purpose. Set higher only if a wall flares up again under load.
  const ZP_INTER_REQUEST_MS = Number(process.env.ZONAPROP_ENRICH_DELAY_MS) || 0;
  const defaultPerSource = Number(process.env.ENRICH_CONCURRENCY) || 5;
  const perSource =
    source === 'mercadolibre' ? ML_CONCURRENCY
    : source === 'zonaprop' ? ZP_CONCURRENCY
    : defaultPerSource;
  // Direct-fetch gate: throttled for ML so we don't trip the bot wall.
  const directGate = pLimit(perSource);
  // Agent gate: claude calls go through Anthropic's IP, not the container's,
  // so the ML wall doesn't apply. Run many in parallel to make a dent in
  // big pending lists. Default 6; tunable via env.
  const AGENT_CONCURRENCY = Number(process.env.AGENT_CONCURRENCY) || 6;
  const agentGate = pLimit(AGENT_CONCURRENCY);
  // Proper serialization for ML: each concurrent waiter grabs the NEXT
  // available slot (now + delay since the previous slot). Without this,
  // 2 concurrent tasks would both see `lastRequestAt`, compute the same
  // wait, and fire in a burst — which is exactly what trips the wall.
  let nextSlotMs = 0;
  // Per-request inter-arrival delay. Set per source so we throttle ML and
  // Zonaprop (Cloudflare) but let argenprop/remax run as fast as the gate
  // allows.
  const interRequestDelay =
    source === 'mercadolibre' ? ML_INTER_REQUEST_MS
    : source === 'zonaprop' ? ZP_INTER_REQUEST_MS
    : 0;
  async function throttleIfMl() {
    if (interRequestDelay <= 0) return;
    const now = Date.now();
    const myTurn = Math.max(nextSlotMs, now);
    nextSlotMs = myTurn + interRequestDelay;
    const wait = myTurn - now;
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 10_000;
  // ML walls are handled per-listing via the agent fallback (WebFetch).
  // No circuit breaker any more.
  const tasks = rows.map((r) =>
    (async () => {
      // Mark the attempt before we even start so a crash mid-task doesn't
      // leave the listing in an "always pending" state.
      db.prepare(MARK_ATTEMPTED).run(Date.now(), r.id);
      try {
        // Phase 1 — direct fetch under the throttled directGate. Returns
        // either { extra } when something useful was extracted, { walled }
        // when ML's wall rejected us (skip to agent), { gone } when 404/410.
        // Counters are incremented INSIDE the gate so they reflect tasks
        // doing real work, not the 974 IIFEs queued behind it.
        const directResult = await directGate(async () => {
          started++;
          inFlight++;
          emitProgress();
          try {
            let extra = null;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              try {
                await throttleIfMl();
                extra = await enricher(r.url);
              } catch (err) {
                if (err.name === 'ListingGoneError') {
                  db.prepare('UPDATE listings SET active = 0 WHERE id = ?').run(r.id);
                  return { gone: true };
                }
                if (err.name === 'MercadoLibreBlockedError' || err.name === 'CloudflareWalledError') {
                  // Direct fetch is hopeless on these — bot wall blocking us
                  // from inside the challenge. Skip to the agent which uses
                  // Anthropic's IP via WebFetch.
                  return { walled: true };
                }
                if (attempt < MAX_ATTEMPTS) {
                  logger.warn(
                    { err: err.message, listingId: r.id, attempt, url: r.url },
                    'enrich attempt failed, retrying after 10s',
                  );
                  await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
                  continue;
                }
                throw err;
              }
              if (extra && (extra.covered_m2 != null || extra.age_years != null)) break;
              if (attempt < MAX_ATTEMPTS) {
                logger.info(
                  { listingId: r.id, attempt, url: r.url },
                  'enrich returned empty, retrying after 10s',
                );
                await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
              }
            }
            return { extra };
          } finally {
            inFlight--;
            emitProgress();
          }
        });
        if (directResult.gone) {
          gone++;
          emitProgress();
          return;
        }
        let extra = directResult.extra || null;
        // Phase 2 — agent escalation on its own gate (higher concurrency,
        // different IP). Runs when the direct fetch couldn't recover the
        // missing fields OR when ML's wall blocked the direct attempt.
        const needsAgent =
          useAgentFallback && (!extra || (extra.covered_m2 == null && extra.age_years == null));
        if (needsAgent) {
          await agentGate(async () => {
            agentInFlight++;
            emitProgress();
            try {
              const agentExtra = await escalateToAgent(r, source);
              if (agentExtra && (agentExtra.covered_m2 != null || agentExtra.age_years != null)) {
                extra = { ...(extra || {}), ...agentExtra };
                healed++;
                logger.info(
                  { url: r.url, source, extracted: Object.keys(agentExtra) },
                  'auto-heal succeeded',
                );
              }
            } finally {
              agentInFlight--;
              emitProgress();
            }
          });
        }
        if (!extra || (extra.covered_m2 == null && extra.age_years == null)) {
          failed++;
          emitProgress();
          return;
        }
        // Reconcile the three m² fields. Rules (in order):
        //   1. extra.uncovered_m2 may come straight from the source (balcony /
        //      patio area). Prefer it over inference.
        //   2. If we have total + uncovered → covered = total - uncovered.
        //   3. If we have total + covered → uncovered = total - covered.
        //   4. If we have total but neither covered nor uncovered → assume
        //      it's all covered with no uncovered (matches a typical interior
        //      apartment without balcony).
        const merged = {
          covered_m2: extra.covered_m2 ?? r.covered_m2,
          total_m2: extra.total_m2 ?? r.total_m2,
          uncovered_m2: extra.uncovered_m2 ?? r.uncovered_m2,
        };
        if (
          merged.covered_m2 == null &&
          Number.isFinite(merged.total_m2) &&
          Number.isFinite(merged.uncovered_m2) &&
          merged.total_m2 > merged.uncovered_m2
        ) {
          merged.covered_m2 = merged.total_m2 - merged.uncovered_m2;
        }
        if (
          merged.uncovered_m2 == null &&
          Number.isFinite(merged.total_m2) &&
          Number.isFinite(merged.covered_m2) &&
          merged.total_m2 > merged.covered_m2
        ) {
          merged.uncovered_m2 = merged.total_m2 - merged.covered_m2;
        }
        if (
          merged.covered_m2 == null &&
          merged.uncovered_m2 == null &&
          Number.isFinite(merged.total_m2)
        ) {
          merged.covered_m2 = merged.total_m2;
          merged.uncovered_m2 = 0;
        }
        const homog = homogenize(merged);
        const ageY = extra.age_years ?? r.age_years;
        const band = ageY != null ? ageBand(ageY) : null;
        // Amenity logic: the detail page's structured fields are the source
        // of truth — title can be misleading ("Cochera Fija" in a listing
        // whose detail page shows Cocheras:0 means the seller is fishing).
        // When the detail page exposes the label, trust it; otherwise leave
        // the existing flag alone.
        const descLower = (extra.description || '').toLowerCase();
        const detailHasPoolBody = /pileta|piscina/.test(descLower) ? 1 : 0;
        const detailHasAmenitiesBody = /amenit|gimnasio|laundry|seguridad|\bsum\b|parrilla|solarium|spa\b/.test(descLower) ? 1 : 0;
        // Floor: prefer the scraper's structured value if it returned one,
        // otherwise mine the description for "segundo piso", "Piso 5", "PB"
        // patterns. Falls back to whatever the row already has.
        const floorFromExtra = extra.floor ?? null;
        const floorFromDesc = floorFromExtra
          ? null
          : extractFloorFromText(extra.description || '');
        const floorFinal = floorFromExtra ?? floorFromDesc ?? null;
        // Garage: if detail page reported parking count (label structured),
        // that's authoritative. parking=0 means seller put 0 cocheras in the
        // form even if the title says otherwise → trust the form.
        // Otherwise fall back to body-text detection, then existing flag.
        let finalGarage;
        if (extra.parking != null) {
          finalGarage = extra.parking > 0 ? 1 : 0;
        } else if (/\bcochera|\bgarage|\bgaraje|estacionamiento/.test(descLower)) {
          finalGarage = 1;
        } else {
          finalGarage = r.has_garage ?? 0;
        }
        // Pool / amenities: no equivalent structured label exists on most
        // detail pages, so we add signal from description text but never
        // downgrade an existing flag.
        const finalPool = Math.max(detailHasPoolBody, r.has_pool ?? 0);
        const finalAmenities = Math.max(detailHasAmenitiesBody, r.has_amenities ?? 0);
        // Trust the detail page's breadcrumb (alquiler/venta) over the
        // bucket we scraped from. ML cross-contaminates buckets but the
        // breadcrumb at /MLA-XXX/ is always correct for that listing.
        if (
          extra.operation &&
          (extra.operation === 'venta' || extra.operation === 'alquiler') &&
          extra.operation !== r.operation
        ) {
          db.prepare('UPDATE listings SET operation = ? WHERE id = ?').run(extra.operation, r.id);
          logger.info(
            { listingId: r.id, url: r.url, from: r.operation, to: extra.operation },
            'enrich: reclassified operation from detail-page breadcrumb',
          );
        }
        db.prepare(UPDATE_ENRICHED).run(
          extra.covered_m2 ?? null,
          merged.uncovered_m2 ?? null,
          extra.total_m2 ?? null,
          homog,
          extra.rooms ?? null,
          extra.bedrooms ?? null,
          extra.bathrooms ?? null,
          finalGarage,
          finalPool,
          finalAmenities,
          extra.age_years ?? null,
          band,
          floorFinal,
          Date.now(),
          r.id,
        );
        // Re-evaluate status and financed price with the FULL detail-page
        // description. The card preview often truncates "ANTICIPO + CUOTAS"
        // patterns, so a listing classified as `disponible` at scrape time
        // can be revealed as `construccion` once we read the real body.
        if (extra.description) {
          const fakeListing = {
            description: extra.description,
            amenities: [],
            property_type: 'departamento',
          };
          const cls = classifyStatus(fakeListing);
          const fin = parseFinancedPrice(extra.description);
          let newStatus = cls.status;
          let newPrice = r.price;
          let newCurrency = r.currency;
          let newPriceUsd = r.price_usd;
          let newDeliveryYear = cls.delivery_year ?? r.delivery_year;
          if (fin && Number.isFinite(fin.totalPrice) && r.price != null) {
            const matches = Math.abs(r.price - fin.anticipo) / fin.anticipo <= 0.01;
            if (matches && fin.totalPrice > r.price) {
              newPrice = fin.totalPrice;
              newCurrency = fin.currency;
              newPriceUsd = toUsd(newPrice, newCurrency, fxRate);
              if (newStatus === 'disponible') newStatus = 'construccion';
            }
          }
          const changed =
            newStatus !== r.status ||
            (newPrice !== r.price && Number.isFinite(newPrice)) ||
            (newDeliveryYear !== r.delivery_year && newDeliveryYear != null);
          if (changed) {
            db.prepare(UPDATE_STATUS_PRICE).run(
              newStatus,
              newPrice ?? r.price,
              newCurrency ?? r.currency,
              newPriceUsd ?? r.price_usd,
              newDeliveryYear ?? null,
              r.id,
            );
            logger.info(
              {
                listingId: r.id,
                url: r.url,
                oldStatus: r.status,
                newStatus,
                oldPrice: r.price,
                newPrice,
              },
              'enrich: re-evaluated status/price from detail',
            );
          }
        }
        enriched++;
        emitProgress();
      } catch (err) {
        logger.warn({ err: err.message, listingId: r.id, url: r.url }, 'enrich detail failed');
        failed++;
        emitProgress();
      }
    })(),
  );
  await Promise.all(tasks);
  if (onProgress) {
    onProgress({
      phase: 'enrich',
      source,
      neighborhood,
      status: 'done',
      enriched,
      failed,
      healed,
      gone,
      started,
      in_flight: 0,
      agent_in_flight: 0,
      total: totalCount,
    });
  }
  logger.info(
    { source, neighborhood, enriched, failed, healed, gone, candidates: totalCount, concurrency: perSource },
    'enrichment done',
  );
  return { enriched, failed, healed, gone, candidates: totalCount };
}

export async function enrichAfterScrape(neighborhood, { onProgress, limitPerSource = 10000, force = false } = {}) {
  // Run all sources concurrently. Each enricher uses Playwright (separate
  // browser contexts) or HTTP (no shared state), so there's no cross-source
  // contention. With per-source concurrency of 5 and 4 sources, total
  // in-flight detail fetches = 20 — comfortably within Playwright + Mac M4.
  const sources = Object.keys(ENRICHERS);
  const entries = await Promise.all(
    sources.map(async (source) => {
      try {
        const r = await enrichListingsForSource({
          source,
          neighborhood: neighborhood.id || neighborhood,
          limit: limitPerSource,
          onProgress,
          force,
        });
        return [source, r];
      } catch (err) {
        logger.warn({ source, err: err.message }, 'enrichAfterScrape source failed');
        return [source, { error: err.message }];
      }
    }),
  );
  return Object.fromEntries(entries);
}
