import { newContext } from '../browser.js';
import { logger } from '../logger.js';
import { sleep, jitter, safeNumber } from './base.js';

// Remax Argentina is an Angular SPA; cards render under custom element
// <qr-card-property>. Selectors discovered in March 2026 — if they break,
// re-run the probe in scripts/probe-remax.js or escalate to an auto-heal agent.

const BASE = 'https://www.remax.com.ar';

// Remax's location filter requires its internal numeric ID + structured slug,
// in the form `locations=in::::<ID>@<slug># null# <state>:::`. Each neighborhood
// in data/neighborhoods.json carries `remax_location_id` (the city ID) and
// `remax_state` (the human state name). When those are missing, we fall back
// to the old URL form and rely on the post-filter to drop off-barrio listings.
function buildUrl(neighborhood, operation, page) {
  const op = operation === 'venta' ? 'buy' : 'rent';
  // operationId in the Remax taxonomy: 1=venta, 2=alquiler.
  const operationId = operation === 'venta' ? 1 : 2;
  // typeId=2 → "Departamento". We send the dept-related codes the UI uses.
  const typeIds = '1,2,3,4,5,6,7,8';
  const sort = '-createdAt';
  const params = new URLSearchParams();
  params.set('page', String(page - 1)); // Remax is 0-indexed
  params.set('pageSize', '24');
  params.set('sort', sort);
  params.set('in:operationId', String(operationId));
  params.set('in:typeId', typeIds);
  if (neighborhood.remax_location_id) {
    // City-level (CABA barrios): 4 colons before the id (`in::::`).
    const slug = neighborhood.id;
    const state = (neighborhood.remax_state || 'capital federal').toLowerCase();
    const token = `in::::${neighborhood.remax_location_id}@${slug}# null# ${state}:::`;
    params.set('locations', token);
  } else if (neighborhood.remax_county_id) {
    // County/partido-level (GBA): 3 colons before the id (`in:::`).
    const slug = neighborhood.id;
    const state = (neighborhood.remax_state || 'buenos aires').toLowerCase();
    const token = `in:::${neighborhood.remax_county_id}@${slug}# null# ${state}:::`;
    params.set('locations', token);
  } else {
    params.set('locations', neighborhood.id);
  }
  return `${BASE}/listings/${op}?${params.toString()}`;
}

async function parseCards(page) {
  return await page.$$eval('qr-card-property', (cards) => {
    function text(el, sel) {
      const n = el.querySelector(sel);
      return n ? (n.textContent || '').replace(/\s+/g, ' ').trim() : null;
    }
    const out = [];
    for (const card of cards) {
      const link = card.querySelector('a.card-remax__href, a.carousel__href');
      const href = link ? link.getAttribute('href') : null;
      if (!href) continue;

      // Slug from URL is our external id surrogate.
      const slug = href.replace(/^\/listings\//, '').split('?')[0];

      // m² features: each ".card__feature--item p" has "<span>N</span> label".
      const features = [...card.querySelectorAll('.card__feature--item p, .card__feature--item span')]
        .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const featBlob = features.join(' · ').toLowerCase();

      out.push({
        href,
        slug,
        priceText: text(card, '.card__price'),
        expensesText: text(card, '.card__expenses'),
        address: text(card, '.card__address'),
        ubication: text(card, '.card__ubication'),
        featBlob,
        cardText: (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
      });
    }
    return out;
  });
}

function parsePrice(text) {
  if (!text) return { price: null, currency: null };
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Patterns: "310.000 USD", "USD 310.000", "$ 250.000.000", "1.500.000 ARS"
  const m = cleaned.match(/(USD|U\$S|U\$D|ARS|\$)\s*([\d.,]+)|([\d.,]+)\s*(USD|U\$S|U\$D|ARS|\$)/i);
  if (!m) return { price: null, currency: null };
  const sym = (m[1] || m[4] || '').toUpperCase();
  const num = m[2] || m[3];
  const currency = /USD|U\$S|U\$D/i.test(sym) ? 'USD' : 'ARS';
  return { price: safeNumber(num), currency };
}

function parseFeatureBlob(blob) {
  const out = {};
  if (!blob) return out;
  const tot = blob.match(/(\d+)\s*m²?\s*total/);
  if (tot) out.total_m2 = Number(tot[1]);
  const cub = blob.match(/(\d+)\s*m²?\s*(?:cubie|cub\.)/);
  if (cub) out.covered_m2 = Number(cub[1]);
  const amb = blob.match(/(\d+)\s*ambient/);
  if (amb) out.rooms = Number(amb[1]);
  if (!out.rooms && /monoambiente/.test(blob)) out.rooms = 1;
  const dorm = blob.match(/(\d+)\s*dormitor/);
  if (dorm) out.bedrooms = Number(dorm[1]);
  const ban = blob.match(/(\d+)\s*ba[ñn]/);
  if (ban) out.bathrooms = Number(ban[1]);
  const coch = blob.match(/(\d+)\s*coch/);
  if (coch) out.parking = Number(coch[1]);
  const age = blob.match(/(\d{1,3})\s*años?\s*antig/);
  if (age) out.age_years = Number(age[1]);
  if (/a\s*estrenar|estreno/.test(blob)) out.age_years = 0;
  return out;
}

function parseFloor(text) {
  if (!text) return null;
  const m1 = text.match(/\bpiso\s*[nº°#:]?\s*(\d{1,3})\b/i);
  if (m1) return m1[1];
  if (/\bplanta\s+baja\b|\bP\.?B\.?\b/i.test(text)) return 'PB';
  return null;
}

function toListing(raw, neighborhood, operation) {
  const url = raw.href.startsWith('http') ? raw.href : BASE + raw.href;
  const { price, currency } = parsePrice(raw.priceText);
  const feats = parseFeatureBlob(raw.featBlob);

  const blob = ((raw.cardText || '') + ' ' + (raw.featBlob || '')).toLowerCase();
  const has_pool = /pileta|piscina/.test(blob);
  // Trust the structured "N coch" signal from the feature blob.
  const has_garage = feats.parking != null && feats.parking > 0;
  const has_amenities = /amenit|gimnasio|laundry|seguridad|sum\b/.test(blob);

  const floor = parseFloor(raw.address) || parseFloor(raw.cardText);

  const totalArea = feats.total_m2 ?? null;
  const coveredArea = feats.covered_m2 ?? null;

  return {
    source: 'remax',
    external_id: raw.slug,
    url,
    operation,
    city: null,
    neighborhood: neighborhood.id,
    neighborhood_raw: raw.ubication || raw.address || neighborhood.display,
    property_type: 'departamento',
    rooms: feats.rooms ?? null,
    bedrooms: feats.bedrooms ?? null,
    bathrooms: feats.bathrooms ?? null,
    covered_m2: coveredArea,
    uncovered_m2:
      Number.isFinite(totalArea) && Number.isFinite(coveredArea) && totalArea > coveredArea
        ? totalArea - coveredArea
        : null,
    total_m2: totalArea,
    age_years: feats.age_years ?? null,
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
    // The card text is rich — normalize.js will mine it for fallback age etc.
    description: raw.cardText.slice(0, 1500),
    raw: { priceText: raw.priceText, featBlob: raw.featBlob, address: raw.address },
  };
}

async function fetchPage(neighborhood, operation, page) {
  const url = buildUrl(neighborhood, operation, page);
  const ctx = await newContext();
  try {
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'load', timeout: 60_000 });
    // qr-card-property is a custom element; wait for it as "attached" because
    // by default Playwright's waitForSelector also requires visibility.
    await p
      .waitForSelector('qr-card-property', { state: 'attached', timeout: 25_000 })
      .catch(() => null);
    // Small settle delay so all 24 cards are rendered, not just the first ones.
    await p.waitForTimeout(2_500);
    return await parseCards(p);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Pull the structured features from a Remax detail page. The relevant block
// lists "Superficie total: X m²", "Superficie cubierta: Y m²", "Antigüedad:
// N años", "Cocheras: N", etc. We match on body text to be resilient against
// CSS class changes.
export async function enrichDetail(url) {
  const ctx = await newContext();
  try {
    const p = await ctx.newPage();
    const fullUrl = url.startsWith('http') ? url : BASE + url;
    const resp = await p.goto(fullUrl, { waitUntil: 'load', timeout: 45_000 });
    if (resp && (resp.status() === 404 || resp.status() === 410)) {
      const { ListingGoneError } = await import('./base.js');
      throw new ListingGoneError(`http ${resp.status()}`, resp.status());
    }
    await p.waitForTimeout(5_000);
    const text = await p.evaluate(() => document.body.innerText);
    const out = {};
    let m;
    if ((m = text.match(/Superficie\s+total\s*:\s*([\d.,]+)\s*m²?/i))) out.total_m2 = safeNumber(m[1]);
    if ((m = text.match(/Superficie\s+cubierta\s*:\s*([\d.,]+)\s*m²?/i))) out.covered_m2 = safeNumber(m[1]);
    if ((m = text.match(/Ambientes\s*:\s*(\d+)/i))) out.rooms = Number(m[1]);
    if ((m = text.match(/Dormitorios\s*:\s*(\d+)/i))) out.bedrooms = Number(m[1]);
    if ((m = text.match(/Ba[ñn]os\s*:\s*(\d+)/i))) out.bathrooms = Number(m[1]);
    if ((m = text.match(/Cocheras\s*:\s*(\d+)/i))) out.parking = Number(m[1]);
    if ((m = text.match(/Antig[üu]edad\s*:\s*(\d+)\s*años?/i))) out.age_years = Number(m[1]);
    if (out.age_years == null && /Antig[üu]edad\s*:\s*a\s*estrenar/i.test(text)) out.age_years = 0;
    return out;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Remax's `locations` query param does NOT filter by neighborhood — it returns
// nationwide results. We must post-filter by inspecting each listing's slug
// (the part of the URL after /listings/) and the rendered address text.
function listingMatchesNeighborhood(listing, neighborhood) {
  const target = [neighborhood.id, ...(neighborhood.aliases || [])]
    .map(normalizeText)
    .filter(Boolean);
  const haystack = [listing.url, listing.neighborhood_raw, listing.description]
    .filter(Boolean)
    .map(normalizeText)
    .join(' | ');
  return target.some((t) => haystack.includes(t));
}

export async function* iterateListings(neighborhood, operation, _opts = {}) {
  let page = 1;
  let consecutiveEmpty = 0;
  // No hard page cap — break on empty pages OR when no NEW external_ids
  // came back (Remax sometimes loops the last page).
  const seenIds = new Set();
  while (true) {
    let raws;
    try {
      raws = await fetchPage(neighborhood, operation, page);
    } catch (err) {
      logger.warn(
        { err: err.message, page, neighborhood: neighborhood.id, operation },
        'remax fetch failed',
      );
      throw err;
    }
    const all = raws.map((r) => toListing(r, neighborhood, operation));
    // Post-filter: drop listings that clearly aren't in the requested
    // neighborhood. Without this Remax pollutes the data with nationwide
    // properties (Córdoba, La Plata, etc.) because its location filter
    // doesn't actually apply to the query.
    const inNeighborhood = all.filter((l) => listingMatchesNeighborhood(l, neighborhood));
    const droppedOffTopic = all.length - inNeighborhood.length;
    if (droppedOffTopic > 0) {
      logger.info(
        { page, neighborhood: neighborhood.id, dropped: droppedOffTopic, kept: inNeighborhood.length },
        'remax: dropped off-neighborhood listings',
      );
    }
    const listings = inNeighborhood.filter((l) => !seenIds.has(l.external_id));
    for (const l of listings) seenIds.add(l.external_id);
    if (all.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) break;
    } else {
      consecutiveEmpty = 0;
    }
    if (listings.length === 0 && inNeighborhood.length > 0) {
      logger.info(
        { page, total: inNeighborhood.length, neighborhood: neighborhood.id, operation },
        'remax: page returned no new listings — likely past the end',
      );
      break;
    }
    yield { page, listings, totalHint: null };
    await sleep(jitter(800, 2200));
    page++;
  }
}
