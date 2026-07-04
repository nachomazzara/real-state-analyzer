import pLimit from 'p-limit';
import { config } from '../config.js';
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

// Translate raw enrich errors (or our own "no useful data" verdicts) into a
// short, human-readable category so the script can show the user WHY a
// listing failed instead of just an opaque count. Keep the set small — a
// handful of well-named buckets > a long tail of one-off messages.
//
//   auth          MercadoLibre redirected to /login or page demanded login.
//                 Means cookies / session are dead.
//   blocked       Anti-bot wall (refresh-loop, MercadoLibreBlockedError,
//                 CloudflareWalledError). The page never settled.
//   timeout       Per-listing 45s deadline expired (LISTING_TIMEOUT_MS in
//                 the channel loop). Usually means the page was hanging in
//                 a partial-load state.
//   transient     Playwright/browser race ("Target page, context or browser
//                 has been closed", "Navigation interrupted"). One-off,
//                 retryable on the next pass.
//   no_data       Page loaded fine but the parser couldn't extract any of
//                 covered_m2 / age_years. The listing genuinely lacks those
//                 fields in the source. Re-attempting won't help.
//   network       fetch / DNS / TLS layer error.
//   other         Unmatched.
export function categorizeError(err, hint) {
  // Explicit hint overrides — for failures that aren't carrying a real Error
  // object ("no_data" = page parsed empty, "auth"/"aborted" = drained queue
  // after a breaker tripped). Saves the regex roulette below.
  if (hint && ['no_data', 'auth', 'aborted', 'blocked', 'timeout', 'transient'].includes(hint)) {
    return hint;
  }
  const name = err?.name || '';
  const msg = (err?.message || hint || '').toLowerCase();
  if (name === 'MercadoLibreAuthError' || /cookies likely expired|page demands login|auth redirect/.test(msg)) return 'auth';
  if (name === 'MercadoLibreBlockedError' || name === 'CloudflareWalledError') return 'blocked';
  if (/refresh-loop|anti-bot|datadome|captcha/.test(msg)) return 'blocked';
  if (/listing timeout|deadline exceeded|navigation timeout/.test(msg)) return 'timeout';
  if (/target page, context or browser has been closed|page closed|context closed|frame was detached/.test(msg)) return 'transient';
  if (/net::|getaddrinfo|econnreset|enotfound|connect timeout/.test(msg)) return 'network';
  return 'other';
}

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
    address = COALESCE(?, address),
    lat = COALESCE(?, lat),
    lng = COALESCE(?, lng),
    sub_zone = COALESCE(?, sub_zone),
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
  // Tally of why listings failed (category → count). Emitted on every
  // progress event so the script can show a real-time breakdown like
  // `fail=12 (refresh_loop:7 timeout:3 no_data:2)` instead of just a
  // total count. Helps the user spot patterns mid-run ("ML walled us"
  // vs "this barrio has crappy listings").
  const failBuckets = Object.create(null);
  // The categorized reason for the MOST RECENT failure. Useful for the
  // script's per-listing log line so the user sees WHY each listing
  // failed as soon as it happens.
  let lastFailure = null;
  function recordFailure(err, hint) {
    const category = categorizeError(err, hint);
    failBuckets[category] = (failBuckets[category] || 0) + 1;
    lastFailure = {
      category,
      message: err?.message ? String(err.message).slice(0, 180) : (hint || category),
    };
  }
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
      // Categorized failure visibility. `failBuckets` is the running tally
      // (auth/blocked/timeout/no_data/…); `lastFailure` carries the most
      // recent error so the script can show a one-liner reason per fail.
      // Both default to safe empty shapes for non-ML sources (no failures
      // recorded → empty buckets).
      fail_buckets: { ...failBuckets },
      last_failure: lastFailure,
    });
  }
  // ML cadence is "channel-based": ML_CHANNELS independent worker streams
  // run in parallel. Each channel processes its share of listings
  // sequentially: navigate → extract → wait ML_DELAY (jittered 2-5s) →
  // next. This mimics a human who keeps a small handful of tabs in flight
  // continuously rather than firing strict pair-bursts. Faster than the
  // old burst-of-2 design while still looking organic (~3 active tabs at
  // any moment + jittered inter-request spacing per channel).
  const ML_CHANNELS = Number(process.env.ML_CHANNELS) || 3;
  const ML_DELAY_MIN_MS = Number(process.env.ML_DELAY_MIN_MS) || 2_000;
  const ML_DELAY_MAX_MS = Number(process.env.ML_DELAY_MAX_MS) || 5_000;
  // "Long break" cadence — every ML_BREAK_EVERY listings on a channel, pause
  // for ML_BREAK_MIN..MAX ms. Mimics a human stepping away (lunch, coffee,
  // bathroom). Defaults are off (0 = disabled) so the server's standard
  // streaming behavior is unchanged; the CLI script run-analysis.js sets
  // them to 30 listings / 60-180s for CI / cron use.
  const ML_BREAK_EVERY = Number(process.env.ML_BREAK_EVERY) || 0;
  const ML_BREAK_MIN_MS = Number(process.env.ML_BREAK_MIN_MS) || 60_000;
  const ML_BREAK_MAX_MS = Number(process.env.ML_BREAK_MAX_MS) || 180_000;
  // Zonaprop sits behind Cloudflare Turnstile. Detail-page navigation clears
  // cookies per request (zonaprop.js:310) so Cloudflare sees each request as
  // a fresh session — that makes throttling unnecessary by default. Set
  // ZONAPROP_ENRICH_DELAY_MIN/MAX_MS only if a wall flares up under load.
  const ZP_CONCURRENCY = Number(process.env.ZONAPROP_ENRICH_CONCURRENCY) || 5;
  const ZP_DELAY_MIN_MS = Number(process.env.ZONAPROP_ENRICH_DELAY_MIN_MS) || 0;
  const ZP_DELAY_MAX_MS = Number(process.env.ZONAPROP_ENRICH_DELAY_MAX_MS) || 0;
  const defaultPerSource = Number(process.env.ENRICH_CONCURRENCY) || 5;
  const perSource =
    source === 'mercadolibre' ? ML_CHANNELS
    : source === 'zonaprop' ? ZP_CONCURRENCY
    : defaultPerSource;
  // Direct-fetch gate: throttled for ML so we don't trip the bot wall.
  const directGate = pLimit(perSource);
  // Agent gate: claude calls go through Anthropic's IP, not the container's,
  // so the ML wall doesn't apply. Run many in parallel to make a dent in
  // big pending lists. Default 6; tunable via env.
  const AGENT_CONCURRENCY = Number(process.env.AGENT_CONCURRENCY) || 6;
  const agentGate = pLimit(AGENT_CONCURRENCY);
  // Per-request streaming throttle (used by Zonaprop only — ML is batched
  // below). Multiple concurrent waiters serialize via nextSlotMs so they
  // don't all read it as "now" and fire in a burst.
  let nextSlotMs = 0;
  const [delayMinMs, delayMaxMs] =
    source === 'zonaprop' ? [ZP_DELAY_MIN_MS, ZP_DELAY_MAX_MS]
    : [0, 0];
  async function throttleIfMl() {
    if (delayMaxMs <= 0) return;
    const delay = delayMinMs + Math.random() * (delayMaxMs - delayMinMs);
    const now = Date.now();
    const myTurn = Math.max(nextSlotMs, now);
    nextSlotMs = myTurn + delay;
    const wait = myTurn - now;
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }
  // ML: 1 attempt — retries multiply time spent and rarely rescue listings
  // that failed on first try (the failures are usually structural template
  // issues, not transient network blips). Other sources: 3 attempts as before.
  const MAX_ATTEMPTS = source === 'mercadolibre' ? 1 : 3;
  const RETRY_DELAY_MS = 10_000;
  // Hard ceiling per listing so one slow page can't stall a Promise.all batch.
  // ML: 45s (30s nav + 3s ready poll + small margin). Others: 90s to give
  // the agent fallback time to run.
  const LISTING_TIMEOUT_MS = source === 'mercadolibre' ? 45_000 : 90_000;
  // ML walls are handled per-listing via the agent fallback (WebFetch).
  // Auth failures are different: once ML signals "no session / cookies invalid"
  // it stays that way for the whole run, so we flip a sticky breaker and skip
  // every remaining listing instead of burning hours retrying each 3 times.
  let mlAuthBroken = false;
  async function processOne(r) {
      // ML auth already known broken from a previous task in this run? Skip
      // immediately — burning through 2000 more listings each retrying 3x
      // accomplishes nothing without fresh cookies.
      if (source === 'mercadolibre' && mlAuthBroken) {
        recordFailure(null, 'auth');
        failed++;
        emitProgress();
        return;
      }
      // Mark the attempt before we even start so a crash mid-task doesn't
      // leave the listing in an "always pending" state.
      db.prepare(MARK_ATTEMPTED).run(Date.now(), r.id);
      try {
        // Phase 1 — direct fetch. Non-ML sources go through the throttled
        // directGate (pLimit). ML bypasses the gate entirely: concurrency is
        // already controlled by the batch loop (Promise.all of ML_BURST_SIZE
        // listings), and using pLimit here is actively harmful — if a per-
        // listing deadline fires in processOneWithDeadline, the inner enricher
        // promise keeps running orphaned and HOLDS the pLimit slot. That makes
        // every subsequent batch queue forever behind those zombie slots.
        const runDirect = source === 'mercadolibre' ? (fn) => fn() : directGate;
        const directResult = await runDirect(async () => {
          started++;
          inFlight++;
          emitProgress();
          try {
            let extra = null;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              // Late check: another task in flight may have just tripped the
              // breaker while we were waiting on the gate.
              if (source === 'mercadolibre' && mlAuthBroken) return { authBroken: true };
              try {
                await throttleIfMl();
                extra = await enricher(r.url);
              } catch (err) {
                if (err.name === 'ListingGoneError') {
                  db.prepare('UPDATE listings SET active = 0 WHERE id = ?').run(r.id);
                  return { gone: true };
                }
                if (err.name === 'MercadoLibreAuthError') {
                  // Sticky breaker: first task to see this trips it; everyone
                  // else queued behind sees it and short-circuits. Logged
                  // once with a clear remediation message.
                  if (!mlAuthBroken) {
                    mlAuthBroken = true;
                    logger.error(
                      { err: err.message, source, neighborhood },
                      'MercadoLibre auth failed — stopping ML enrichment for this run. Refresh data/ml-cookies.txt and re-run.',
                    );
                  }
                  return { authBroken: true };
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
        if (directResult.authBroken) {
          // Auth is dead for this run — don't escalate to agent (the agent
          // can't supply user-session-gated data) and don't retry.
          recordFailure(null, 'auth');
          failed++;
          emitProgress();
          return;
        }
        let extra = directResult.extra || null;
        // Phase 2 — agent escalation on its own gate (higher concurrency,
        // different IP). Runs when the direct fetch couldn't recover the
        // missing fields OR when ML's wall blocked the direct attempt.
        //
        // MercadoLibre is excluded by default: WebFetch hits ML with no
        // cookies and gets HTTP 403 every time; the Bash render fallback in
        // the agent skill assumes a `/app/scripts/render-page.js` path that
        // only exists in the Docker image, not on macOS. End result: every
        // ML agent call runs out the 5-minute timeout, holding agentGate
        // slots and stalling the pipeline. Override with ML_USE_AGENT=true
        // if you've configured a working agent path.
        const ML_USE_AGENT = /^(1|true|yes|on)$/i.test(String(process.env.ML_USE_AGENT || ''));
        const sourceUsesAgent = source === 'mercadolibre' ? ML_USE_AGENT : true;
        const needsAgent =
          useAgentFallback && sourceUsesAgent && (!extra || (extra.covered_m2 == null && extra.age_years == null));
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
          recordFailure(null, 'no_data');
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
        // Pool detection — exclude false positives where "pileta" is the
        // kitchen/laundry sink ("pileta de acero inoxidable", "pileta de
        // cocina", "pileta de servicio"), not a swimming pool.
        const detailHasPoolBody = /(?:^|[^a-záéíóúñ])piscina|(?:^|[^a-záéíóúñ])pileta(?!\s+de\s+(?:acero|cocina|granito|servicio|lavar|lavadero|lavarropas|inox))/i.test(descLower) ? 1 : 0;
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
        } else {
          // Negatives: phrases that mention "cochera" but DON'T mean the
          // unit has one.
          //  - Site-wide footer boilerplate (argenprop): "...PH, cocheras y
          //    más en Argenprop".
          //  - Parking sold separately (zonaprop): "Cocheras disponibles a
          //    partir de $40.000", "cochera opcional", "cochera aparte".
          //  - Explicit "sin cochera" / "no incluye cochera".
          //  - The listing itself is a cochera for sale/rent.
          // Argenprop's site-wide footer literally ends with "...cocheras y
          // más en Argenprop." — require that full phrase so we don't risk
          // killing real positive mentions of "cocheras".
          const garageNeg = (
            /\bcocheras\s+y\s+m[áa]s\s+en\s+argenprop\b/.test(descLower) ||
            // Allow 0-2 intermediate adjectives between "cochera(s)" and the
            // negative qualifier: catches "cocheras FIJAS disponibles" /
            // "cochera CUBIERTA opcional" / "cocheras descubiertas a partir de…"
            /\bcocheras?(?:\s+\w+){0,3}\s+(?:disponibles?|opcional(?:es)?|a\s+partir|aparte|por\s+separado|extra|con\s+costo)\b/.test(descLower) ||
            // Plural "cocheras fijas" alone means the building has fixed
            // garage spots SOLD SEPARATELY — not included with the unit. The
            // unit-included variant uses the singular: "cochera fija".
            /\bcocheras\s+fijas\b/.test(descLower) ||
            /\bsin\s+cochera\b/.test(descLower) ||
            /\bno\s+(?:incluye|tiene)\s+cochera\b/.test(descLower) ||
            /\b(?:alquila|alquiler|venta|vende|vendo|en\s+venta)\b[^.]{0,30}\bcochera\b/.test(descLower) ||
            /\bcochera\b[^.]{0,30}\b(?:en\s+venta|en\s+alquiler|en\s+oferta)\b/.test(descLower)
          );
          if (!garageNeg && /\bcochera|\bgarage|\bgaraje|\bestacionamiento/.test(descLower)) {
            finalGarage = 1;
          } else {
            finalGarage = r.has_garage ?? 0;
          }
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
        // When the scraper supplied lat/lng directly (e.g. argenprop's
        // leaflet container data-attrs), compute sub_zone here too so the
        // listing skips the background geocoder entirely.
        let extraLat = null;
        let extraLng = null;
        let extraSubzone = null;
        if (Number.isFinite(extra.lat) && Number.isFinite(extra.lng)) {
          extraLat = extra.lat;
          extraLng = extra.lng;
          if (config.enableSubzones) {
            try {
              const { computeSubZone } = await import('./subzone.js');
              extraSubzone = computeSubZone(extra.lat, extra.lng);
            } catch (e) { /* ignore — sub_zone is optional */ }
          }
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
          extra.address ?? null,
          extraLat,
          extraLng,
          extraSubzone,
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
        recordFailure(err);
        failed++;
        emitProgress();
      }
  }
  // Hard timeout wrapper: a single slow URL must not be allowed to stall the
  // batch Promise.all (which only resolves when its slowest leg completes).
  async function processOneWithDeadline(r) {
    let timer;
    try {
      await Promise.race([
        processOne(r),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`listing timeout ${LISTING_TIMEOUT_MS}ms`)),
            LISTING_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      if (err && err.message && err.message.startsWith('listing timeout')) {
        logger.warn(
          { listingId: r.id, url: r.url, timeoutMs: LISTING_TIMEOUT_MS },
          'enrich: per-listing deadline exceeded — skipping',
        );
        recordFailure(err, 'timeout');
        failed++;
        emitProgress();
        return;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  // Sticky flag — set by either the auth breaker or the consecutive-failure
  // abort. Declared at function scope so the return value can surface it.
  let mlAborted = false;
  let mlAbortReason = null;
  if (source === 'mercadolibre') {
    // Channel dispatch: ML_CHANNELS independent worker streams process
    // their share of rows sequentially. Each channel runs:
    //   navigate → extract → wait 2-5s (jittered) → next listing
    // 3 channels in parallel ⇒ ~3 active tabs at any moment, each one
    // pacing itself between requests. Looks like a human keeping 3 ML
    // tabs open and ctrl-clicking the next listing every couple seconds.
    //
    // Consecutive-failure abort: when ML flags the session/fingerprint
    // every listing fails the same way (refresh-loop, empty body, etc).
    // No point burning 2 hours confirming — after N consecutive failures
    // we throw and let the caller surface a clear "session blown, fix
    // the Chrome" message to the user. Default 5; set
    // ML_ABORT_AFTER_CONSECUTIVE_FAILS=0 to disable.
    const ABORT_AFTER = Number.isFinite(Number(process.env.ML_ABORT_AFTER_CONSECUTIVE_FAILS))
      ? Number(process.env.ML_ABORT_AFTER_CONSECUTIVE_FAILS)
      : 5;
    let consecutiveFailures = 0;
    const channels = Array.from({ length: ML_CHANNELS }, () => []);
    rows.forEach((r, i) => channels[i % ML_CHANNELS].push(r));
    await Promise.all(channels.map(async (channelRows, channelIdx) => {
      for (let i = 0; i < channelRows.length; i++) {
        if (mlAuthBroken || mlAborted) {
          for (let j = i; j < channelRows.length; j++) {
            recordFailure(null, mlAuthBroken ? 'auth' : 'aborted');
            failed++; emitProgress();
          }
          return;
        }
        const beforeFailed = failed;
        const beforeEnriched = enriched;
        await processOneWithDeadline(channelRows[i]);
        if (enriched > beforeEnriched) consecutiveFailures = 0;
        else if (failed > beforeFailed) consecutiveFailures++;
        if (ABORT_AFTER > 0 && consecutiveFailures >= ABORT_AFTER && !mlAborted) {
          mlAborted = true;
          mlAbortReason = `${consecutiveFailures} consecutive failures (threshold=${ABORT_AFTER}) — likely session/fingerprint flagged by ML`;
          logger.error(
            { source, channel: channelIdx, consecutiveFailures, threshold: ABORT_AFTER, done: i + 1, total: channelRows.length },
            'enrich: ML aborting — too many consecutive failures (likely session/fingerprint flagged by ML)',
          );
          // Drain remaining queue fast (same pattern as mlAuthBroken) so the
          // outer Promise.all resolves and the caller sees the counts.
          for (let j = i + 1; j < channelRows.length; j++) {
            recordFailure(null, 'aborted');
            failed++; emitProgress();
          }
          return;
        }
        if (i + 1 < channelRows.length && !mlAuthBroken && !mlAborted) {
          // Regular jittered pause between listings (default 2-5s,
          // CLI bumps to 8-25s).
          const delay = ML_DELAY_MIN_MS + Math.random() * (ML_DELAY_MAX_MS - ML_DELAY_MIN_MS);
          logger.debug(
            { source, channel: channelIdx, done: i + 1, total: channelRows.length, delayMs: Math.round(delay) },
            'enrich: ml channel pause',
          );
          await new Promise((res) => setTimeout(res, delay));
          // Long break every N listings on this channel — simulates a
          // human stepping away. Disabled by default (server flow keeps
          // streaming); CLI sets ML_BREAK_EVERY=30 so a ~hour-long run
          // gets 2-3 idle gaps that match a real person's browsing
          // session.
          if (ML_BREAK_EVERY > 0 && (i + 1) % ML_BREAK_EVERY === 0) {
            const breakMs = ML_BREAK_MIN_MS + Math.random() * (ML_BREAK_MAX_MS - ML_BREAK_MIN_MS);
            logger.info(
              { source, channel: channelIdx, done: i + 1, total: channelRows.length, breakMs: Math.round(breakMs) },
              'enrich: ml long break (mimicking human idle gap)',
            );
            await new Promise((res) => setTimeout(res, breakMs));
          }
        }
      }
    }));
  } else {
    // Other sources: streaming dispatch — all tasks queue behind the pLimit
    // directGate, which throttles per-source. Matches the prior behavior.
    await Promise.all(rows.map(processOneWithDeadline));
  }
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
      fail_buckets: { ...failBuckets },
      last_failure: lastFailure,
    });
  }
  logger.info(
    { source, neighborhood, enriched, failed, healed, gone, candidates: totalCount, concurrency: perSource, delayMinMs, delayMaxMs },
    'enrichment done',
  );
  return {
    enriched,
    failed,
    healed,
    gone,
    candidates: totalCount,
    // Signals from the ML-specific abort logic. Non-ML sources always have
    // these falsy. The standalone script (scripts/scrape-ml.js) inspects
    // these to decide whether to print the "session blown" banner.
    aborted: mlAborted || mlAuthBroken,
    abortReason: mlAbortReason || (mlAuthBroken ? 'MercadoLibreAuthError — cookies/session invalid' : null),
    // Final tally of why listings failed, useful for the end-of-run summary
    // ("23 fails: refresh_loop:14 timeout:6 no_data:3").
    failBuckets: { ...failBuckets },
  };
}

// Sources excluded from the post-scrape enrich pass triggered by the UI.
// MercadoLibre needs CDP-attach to a user-launched Chrome (see
// HOW_TO_SCRAP_ML.md); the standalone script `scripts/scrape-ml.js` calls
// `enrichListingsForSource({source: 'mercadolibre'})` directly with the
// right environment, bypassing this filter.
const UI_EXCLUDED_SOURCES = new Set(['mercadolibre']);

export async function enrichAfterScrape(neighborhood, { onProgress, limitPerSource = 10000, force = false } = {}) {
  // Run all sources concurrently. Each enricher uses Playwright (separate
  // browser contexts) or HTTP (no shared state), so there's no cross-source
  // contention. With per-source concurrency of 5 and 3 sources (ML is
  // excluded — handled by `scripts/scrape-ml.js`), total in-flight detail
  // fetches = 15 — comfortably within Playwright + Mac M4.
  const sources = Object.keys(ENRICHERS).filter((s) => !UI_EXCLUDED_SOURCES.has(s));
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
