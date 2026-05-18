import { newContext } from '../browser.js';
import { logger } from '../logger.js';
import { sleep, jitter, safeNumber } from './base.js';

// Zonaprop is a Next.js SPA. Without JS execution the page returns a stub
// document; we use Playwright + `networkidle` + an explicit selector wait
// to grab the hydrated listing cards.

const BASE = 'https://www.zonaprop.com.ar';

function buildUrl(neighborhood, operation, page) {
  const op = operation === 'venta' ? 'venta' : 'alquiler';
  const slug = neighborhood.id;
  const suffix = page > 1 ? `-pagina-${page}` : '';
  return `${BASE}/departamentos-${op}-${slug}${suffix}.html`;
}

// Zonaprop's current card selector (March 2026): div[data-qa="posting PROPERTY"][data-id]
// Older versions used data-qa="POSTING_CARD"; we accept both as a defensive fallback.
const CARD_SELECTOR = 'div[data-qa="posting PROPERTY"], div[data-qa="POSTING_CARD"]';

async function parseCards(page) {
  return await page.$$eval(CARD_SELECTOR, (nodes) => {
    function txt(el, sel) {
      const n = el.querySelector(sel);
      return n ? (n.textContent || '').trim() : null;
    }
    const out = [];
    for (const c of nodes) {
      const id = c.getAttribute('data-id') || c.getAttribute('data-posting-id') || null;
      // Prefer the explicit data-to-posting URL; fall back to the first <a>.
      const href =
        c.getAttribute('data-to-posting') ||
        c.querySelector('a[href]')?.getAttribute('href') ||
        null;
      if (!id || !href) continue;
      out.push({
        id,
        href,
        price: txt(c, '[data-qa="POSTING_CARD_PRICE"]'),
        expenses: txt(c, '[data-qa="expensas"]'),
        features: txt(c, '[data-qa="POSTING_CARD_FEATURES"]'),
        location: txt(c, '[data-qa="POSTING_CARD_LOCATION"]'),
        address: txt(c, '.postingAddress, [class*="postingAddress"]'),
        description: txt(c, '[data-qa="POSTING_CARD_DESCRIPTION"]'),
      });
    }
    return out;
  });
}

function parsePrice(text) {
  if (!text) return { price: null, currency: null };
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Examples: "USD 130.000", "U$S 130.000", "$ 250.000.000", "Consultar"
  const m = cleaned.match(/(USD|U\$S|U\$D|\$)\s*([\d.,]+)/i);
  if (!m) return { price: null, currency: null };
  const currency = /USD|U\$S|U\$D/i.test(m[1]) ? 'USD' : 'ARS';
  return { price: safeNumber(m[2]), currency };
}

function parseFeatures(text) {
  if (!text) return {};
  // Concatenated by the card with no consistent separator:
  //   "93 m² tot.3 amb.2 dorm.1 baño1 coch." or
  //   "65 m² tot. · 60 m² cub. · 3 amb. · 2 dorm. · 1 baño"
  const lower = text.toLowerCase();
  const out = {};
  const tot = lower.match(/([\d.,]+)\s*m²?\s*tot/);
  if (tot) out.total_m2 = safeNumber(tot[1]);
  const cub = lower.match(/([\d.,]+)\s*m²?\s*cub/);
  if (cub) out.covered_m2 = safeNumber(cub[1]);
  const amb = lower.match(/(\d+)\s*amb/);
  if (amb) out.rooms = Number(amb[1]);
  if (!out.rooms && /monoambiente/.test(lower)) out.rooms = 1;
  const dorm = lower.match(/(\d+)\s*dorm/);
  if (dorm) out.bedrooms = Number(dorm[1]);
  const ban = lower.match(/(\d+)\s*ba[ñn]/);
  if (ban) out.bathrooms = Number(ban[1]);
  // Structured cochera signal — Zonaprop emits "1 coch." in features when the
  // unit has one. This is far more reliable than scanning the description.
  const coch = lower.match(/(\d+)\s*coch/);
  if (coch) out.parking = Number(coch[1]);
  return out;
}

function parseFloor(s) {
  if (!s) return null;
  const m1 = s.match(/\bpiso\s*[nº°#:]?\s*(\d{1,3})\b/i);
  if (m1) return m1[1];
  if (/\bplanta\s+baja\b|\bP\.?B\.?\b/i.test(s)) return 'PB';
  return null;
}

function toListing(raw, neighborhood, operation) {
  const url = raw.href.startsWith('http') ? raw.href : BASE + raw.href;
  const { price, currency } = parsePrice(raw.price);
  const feats = parseFeatures(raw.features);

  const blob = ((raw.description || '') + ' ' + (raw.address || '') + ' ' + (raw.features || ''))
    .toLowerCase();
  // Exclude false positives like "pileta de acero inoxidable" (kitchen sink).
  const has_pool = /(?:^|[^a-záéíóúñ])piscina|(?:^|[^a-záéíóúñ])pileta(?!\s+de\s+(?:acero|cocina|granito|servicio|lavar|lavadero|lavarropas|inox))/i.test(blob);
  // Trust the structured "N coch." token from the features list; that's the
  // only place Zonaprop tells us the UNIT (not the building) has parking.
  const has_garage = feats.parking != null && feats.parking > 0;
  const has_amenities = /amenit|gimnasio|laundry|seguridad|sum\b/.test(blob);

  const ageBlob = ((raw.description || '') + ' ' + (raw.features || '')).toLowerCase();
  let age_years = null;
  if (/a\s*estrenar|estreno/.test(ageBlob)) age_years = 0;
  else {
    const am = ageBlob.match(/(\d+)\s*años?\s+de\s+antig/);
    if (am) age_years = Number(am[1]);
  }

  const floor = parseFloor(raw.address) || parseFloor(raw.description);

  return {
    source: 'zonaprop',
    external_id: String(raw.id),
    url,
    operation,
    city: null,
    neighborhood: neighborhood.id,
    neighborhood_raw: raw.location || neighborhood.display,
    property_type: 'departamento',
    rooms: feats.rooms ?? null,
    bedrooms: feats.bedrooms ?? null,
    bathrooms: feats.bathrooms ?? null,
    covered_m2: feats.covered_m2 ?? null,
    uncovered_m2:
      Number.isFinite(feats.total_m2) &&
      Number.isFinite(feats.covered_m2) &&
      feats.total_m2 > feats.covered_m2
        ? feats.total_m2 - feats.covered_m2
        : null,
    total_m2: feats.total_m2 ?? null,
    age_years,
    has_pool,
    has_amenities,
    has_garage,
    floor,
    amenities: [
      ...(has_pool ? ['pileta'] : []),
      ...(has_garage ? ['cochera'] : []),
    ],
    price,
    currency,
    description: ((raw.description || '') + ' ' + (raw.address || '')).slice(0, 1500),
    raw: { price_raw: raw.price, features_raw: raw.features, address: raw.address },
  };
}

async function fetchPage(neighborhood, operation, page) {
  const url = buildUrl(neighborhood, operation, page);
  const ctx = await newContext();
  try {
    // Same trick as enrichDetail — clear the session cookies so Cloudflare
    // gives us a fresh bot-management state per request instead of carrying
    // a tainted one across the whole batch.
    await ctx._underlying.clearCookies({ domain: '.zonaprop.com.ar' }).catch(() => {});
    await ctx._underlying.clearCookies({ domain: 'zonaprop.com.ar' }).catch(() => {});
    const p = await ctx.newPage();
    // `networkidle` never settles on Zonaprop (third-party trackers keep
    // firing). `load` fires once the window load event has fired — enough
    // for the SPA to hydrate the listing cards.
    await p.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await p.waitForSelector(CARD_SELECTOR, { timeout: 25_000 }).catch(() => null);
    return await parseCards(p);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Cloudflare's interstitial title — same wording on every challenge page.
// If we see it after the wait timeout, the challenge didn't resolve and
// hammering the same URL with Playwright won't help. Fall through to the
// agent (WebFetch over Anthropic IP).
export class CloudflareWalledError extends Error {
  constructor(url) {
    super(`cloudflare challenge stuck on ${url}`);
    this.name = 'CloudflareWalledError';
  }
}

async function isCloudflareChallenge(p) {
  try {
    const title = await p.title();
    if (/just a moment|un momento|verificación de seguridad|verifying you are human/i.test(title)) {
      return true;
    }
    const text = await p.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => '');
    return /verificación de seguridad en curso|cloudflare|attention required/i.test(text);
  } catch {
    return false;
  }
}

// Try to click the Turnstile checkbox if Cloudflare is showing a visible
// challenge. Returns true if we managed to click something. The checkbox
// lives inside a cross-origin iframe served from challenges.cloudflare.com;
// we can't directly click DOM elements inside it (Same-Origin Policy), but
// we can click at the iframe's screen coordinates which forwards the click
// into the iframe.
export async function attemptTurnstileClick(p) {
  try {
    const target = await p.evaluate(() => {
      const ifr = [...document.querySelectorAll('iframe')]
        .find((f) => /challenges\.cloudflare\.com|turnstile/i.test(f.src) || f.title?.includes('challenge'));
      if (ifr) {
        const r = ifr.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) {
          return { kind: 'iframe', iframeX: r.x, iframeY: r.y, fullW: r.width, fullH: r.height };
        }
      }
      const w = document.querySelector('.cf-turnstile, [data-sitekey]');
      if (w) {
        const r = w.getBoundingClientRect();
        return { kind: 'container', iframeX: r.x, iframeY: r.y, fullW: r.width, fullH: r.height };
      }
      return null;
    });
    if (!target) {
      const { logger: log1 } = await import('../logger.js');
      log1.debug('zonaprop click: no target found yet');
      return false;
    }
    const { logger } = await import('../logger.js');
    // Cloudflare's interactive Turnstile checkbox sits at the LEFT of the
    // widget. Click positions empirically work at ~30px from left.
    const x = target.iframeX + 32;
    const y = target.iframeY + target.fullH / 2;
    logger.info(
      { kind: target.kind, iframeX: target.iframeX, iframeY: target.iframeY, w: target.fullW, h: target.fullH, clickX: x, clickY: y },
      'zonaprop: clicking turnstile checkbox',
    );
    await p.mouse.move(x - 200, y - 80, { steps: 8 });
    await p.waitForTimeout(150 + Math.random() * 250);
    await p.mouse.move(x, y, { steps: 12 });
    await p.waitForTimeout(200 + Math.random() * 300);
    await p.mouse.click(x, y, { delay: 80 });
    return true;
  } catch (err) {
    const { logger } = await import('../logger.js');
    logger.warn({ err: err.message }, 'zonaprop click: exception');
    return false;
  }
}

// One-time mutex: the first scraper task that hits Zonaprop without a
// cf_clearance cookie does the heavy "wait for Cloudflare to issue the
// clearance" dance, while every other concurrent task waits behind it. Once
// clearance is in the context's cookie jar, all subsequent navigations skip
// the challenge — Cloudflare validates the cookie and serves the real page.
let warmupPromise = null;

async function hasCloudflareClearance(ctx) {
  try {
    const cookies = await ctx._underlying.cookies('https://www.zonaprop.com.ar');
    return cookies.some((c) => c.name === 'cf_clearance' && c.value);
  } catch {
    return false;
  }
}

async function warmUpCloudflare(ctx) {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    if (await hasCloudflareClearance(ctx)) return true;
    const page = await ctx.newPage();
    try {
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null);
      // Wait up to 30s for the transparent JS challenge to resolve. Cloudflare
      // sets cf_clearance once the browser passes its checks; from then on
      // the cookie travels with every same-origin request.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await hasCloudflareClearance(ctx)) return true;
        if (!(await isCloudflareChallenge(page))) {
          // Challenge cleared (title/text no longer matches) — wait one extra
          // tick for the cookie write.
          await new Promise((r) => setTimeout(r, 500));
          if (await hasCloudflareClearance(ctx)) return true;
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      return false;
    } finally {
      await page.close().catch(() => {});
    }
  })();
  const ok = await warmupPromise;
  // Reset the gate so a later session (cookie expired, ~30min) re-runs warmup.
  if (!ok) warmupPromise = null;
  return ok;
}

// Open one listing's detail page and pull the structured feature table.
// Returns { covered_m2, total_m2, rooms, bedrooms, bathrooms, parking,
// age_years } — any field we couldn't determine is omitted.
export async function enrichDetail(url) {
  const ctx = await newContext();
  try {
    // CRITICAL: clear zonaprop cookies before EVERY request. Cloudflare sets
    // a session bot-management cookie (cf_bm + friends) on the first
    // response; after the second request that cookie is "tainted" and the
    // session gets walled for the rest of its life. Starting fresh per
    // request means Cloudflare assigns a clean session each time and lets
    // us through. Verified: 5/5 sequential requests all PASS with this.
    await ctx._underlying.clearCookies({ domain: '.zonaprop.com.ar' }).catch(() => {});
    await ctx._underlying.clearCookies({ domain: 'zonaprop.com.ar' }).catch(() => {});
    // (Old warmup mutex is no longer needed — cookie reset replaces it.)
    const p = await ctx.newPage();
    const fullUrl = url.startsWith('http') ? url : BASE + url;
    // Synthesize a plausible Referer. Zonaprop URLs from the scraper carry
    // `?n_src=Listado&n_pg=N&n_pos=N` — they came from a listing page in the
    // user's session. Cloudflare flags requests where Referer is blank but
    // the URL pattern says "I was clicked from a listing". Set the Referer
    // to the listing/landing page so the request looks natural.
    const referer = (() => {
      try {
        const u = new URL(fullUrl);
        return `${u.origin}/`;
      } catch { return BASE + '/'; }
    })();
    const resp = await p.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45_000, referer });
    if (resp && (resp.status() === 404 || resp.status() === 410)) {
      const { ListingGoneError } = await import('./base.js');
      throw new ListingGoneError(`http ${resp.status()}`, resp.status());
    }
    // Poll for the real page. If Cloudflare's challenge is up, simulate
    // human activity (mouse moves, scroll) and try to click the Turnstile
    // widget when it appears. One successful click usually drops the wall.
    let foundFeatures = false;
    let clickAttempts = 0;
    let wallSeen = false;
    const stopAt = Date.now() + 30_000;
    while (Date.now() < stopAt) {
      const found = await p.$('.section-icon-features, [class*="icon-feature"]').catch(() => null);
      if (found) { foundFeatures = true; break; }
      const onWall = await isCloudflareChallenge(p);
      if (onWall) {
        wallSeen = true;
        await p.mouse.move(300 + Math.random() * 600, 200 + Math.random() * 300, { steps: 5 }).catch(() => {});
        // Try clicking up to 3 times — Turnstile sometimes needs a moment to
        // mount its iframe between widget appearance and being clickable.
        if (clickAttempts < 3) {
          const clicked = await attemptTurnstileClick(p);
          if (clicked) clickAttempts++;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (wallSeen) {
      const { logger } = await import('../logger.js');
      logger.info(
        { url: fullUrl, clickAttempts, foundFeatures, elapsedMs: Date.now() - (stopAt - 30_000) },
        'zonaprop: cloudflare wall encountered',
      );
    }
    if (!foundFeatures && (await isCloudflareChallenge(p))) {
      throw new CloudflareWalledError(fullUrl);
    }
    const items = await p.evaluate(() => {
      const nodes = [...document.querySelectorAll('.section-icon-features li, .section-icon-features span, [class*="icon-feature"]')];
      const out = [];
      for (const n of nodes) {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 80) out.push(t);
      }
      return [...new Set(out)];
    });
    // Pull the full description for downstream status/price re-evaluation
    // (e.g., "ANTICIPO + CUOTAS" patterns that the card preview truncates).
    const description = await p
      .evaluate(() => (document.body ? document.body.innerText : ''))
      .catch(() => '');
    const blob = items.join(' · ').toLowerCase();
    const out = {};
    let m;
    if ((m = blob.match(/([\d.,]+)\s*m²?\s*tot/))) out.total_m2 = safeNumber(m[1]);
    if ((m = blob.match(/([\d.,]+)\s*m²?\s*cub/))) out.covered_m2 = safeNumber(m[1]);
    if ((m = blob.match(/(\d+)\s*amb/))) out.rooms = Number(m[1]);
    if (out.rooms == null && /monoambiente/.test(blob)) out.rooms = 1;
    if ((m = blob.match(/(\d+)\s*dorm/))) out.bedrooms = Number(m[1]);
    if ((m = blob.match(/(\d+)\s*ba[ñn]/))) out.bathrooms = Number(m[1]);
    if ((m = blob.match(/(\d+)\s*coch/))) out.parking = Number(m[1]);
    if ((m = blob.match(/(\d+)\s*años?\s*(?:de\s+antig)?/))) out.age_years = Number(m[1]);
    if (/a\s*estrenar/.test(blob) && out.age_years == null) out.age_years = 0;
    if (description) out.description = description.slice(0, 6000);
    // Address: zonaprop detail pages render the street+altura near a map-pin
    // icon. Try a dedicated selector first, fall back to a regex on the full
    // page text matching the canonical CABA pattern "<street> <number>, <barrio>,
    // Capital Federal".
    try {
      // Zonaprop's address container has class `section-location` but the tag
      // varies (was h4, now h2/div in some layouts) — don't pin the tag.
      // The `*="postingAddress"` is the older variant from card view; some
      // listings keep that on detail page too.
      const addrEl = await p.$('[class*="section-location"], [class*="map-address"], [data-qa*="location-address"], [class*="postingAddress"]');
      if (addrEl) {
        const t = (await addrEl.textContent())?.trim();
        if (t) out.address = t;
      }
    } catch { /* ignore selector miss */ }
    if (!out.address && description) {
      const am = description.match(/([A-ZÁÉÍÓÚÑ][^\n,]{2,60}\s+\d{2,5}),\s*([^\n,]+),\s*(Capital Federal|Buenos Aires|CABA)/);
      if (am) out.address = am[0].trim();
    }
    return out;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Map-coord fallback: when the text geocoder can't resolve a listing's
// address, open the detail page in Playwright and read coords straight from
// the map widget. Zonaprop pre-renders a static map image (no coords in the
// URL), but clicking `#article-map` triggers Google Maps to mount inside
// `#react-map-modal` and emit anchor tags like
//   `https://maps.google.com/maps?ll=-34.54147,-58.473704&...`
//   `https://www.google.com/maps/@-34.5414698,-58.4737037,16z/...`
// Both contain the listing's exact lat/lng. Returns `{lat, lng}` or null.
export async function fetchMapCoords(url) {
  const ctx = await newContext();
  try {
    await ctx._underlying.clearCookies({ domain: '.zonaprop.com.ar' }).catch(() => {});
    await ctx._underlying.clearCookies({ domain: 'zonaprop.com.ar' }).catch(() => {});
    const p = await ctx.newPage();
    const fullUrl = url.startsWith('http') ? url : BASE + url;
    const referer = (() => {
      try { const u = new URL(fullUrl); return `${u.origin}/`; } catch { return BASE + '/'; }
    })();
    const resp = await p.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45_000, referer });
    if (resp && (resp.status() === 404 || resp.status() === 410)) {
      const { ListingGoneError } = await import('./base.js');
      throw new ListingGoneError(`http ${resp.status()}`, resp.status());
    }
    // Wait for the feature list (same Cloudflare-clear signal enrichDetail uses).
    await p.waitForSelector('.section-icon-features, [class*="icon-feature"]', { timeout: 20_000 }).catch(() => {});
    // Scroll the map into view (lazy-mount) then click. The static map image
    // and the article-map container both forward to the same modal trigger.
    await p.evaluate(() => {
      const el = document.querySelector('#article-map') || document.querySelector('#static-map');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 1200));
    await p.click('#article-map', { timeout: 4000 }).catch(async () => {
      await p.click('#static-map', { timeout: 4000 }).catch(() => {});
    });
    // Google Maps tile + anchor hydration takes ~2-4s after the click.
    await new Promise((r) => setTimeout(r, 4000));
    const coords = await p.evaluate(() => {
      // Prefer the explicit Google Maps URL params (most reliable).
      for (const a of document.querySelectorAll('a[href*="google.com/maps"], a[href*="maps.google"]')) {
        const href = a.href || '';
        let m = href.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
        m = href.match(/\/maps\/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
      }
      // Fallback: scan the full document HTML for a -34.x, -58.x pair
      // (CABA latitude/longitude range). Skip any pair that's outside.
      const html = document.documentElement.outerHTML;
      const pairs = [...html.matchAll(/(-34\.\d{3,8})[^a-zA-Z\d\-]{1,5}(-58\.\d{3,8})/g)];
      for (const m of pairs) {
        const lat = Number(m[1]);
        const lng = Number(m[2]);
        if (lat >= -34.71 && lat <= -34.53 && lng >= -58.55 && lng <= -58.33) {
          return { lat, lng };
        }
      }
      return null;
    });
    return coords;
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function* iterateListings(neighborhood, operation, _opts = {}) {
  let page = 1;
  let consecutiveEmpty = 0;
  let consecutiveNoNew = 0;
  // Track ids we've yielded already. Some sites (and zonaprop in particular)
  // repeat the last page indefinitely once you walk past the real end —
  // if a page brings 0 new ids we know we're past the inventory.
  const seenIds = new Set();
  while (true) {
    let raws;
    try {
      raws = await fetchPage(neighborhood, operation, page);
    } catch (err) {
      logger.warn(
        { err: err.message, page, neighborhood: neighborhood.id, operation },
        'zonaprop fetch failed',
      );
      throw err;
    }
    const allListings = raws.map((r) => toListing(r, neighborhood, operation));
    const newListings = allListings.filter((l) => l && !seenIds.has(l.external_id));
    for (const l of newListings) seenIds.add(l.external_id);

    if (allListings.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) break;
    } else {
      consecutiveEmpty = 0;
    }
    if (newListings.length === 0 && allListings.length > 0) {
      consecutiveNoNew++;
      logger.info(
        { page, total: allListings.length, neighborhood: neighborhood.id, operation },
        'zonaprop: page returned no new listings — likely past the end',
      );
      if (consecutiveNoNew >= 1) break; // one no-new page is enough
    } else {
      consecutiveNoNew = 0;
    }
    yield { page, listings: newListings, totalHint: null };
    await sleep(jitter(800, 2200));
    page++;
  }
}
