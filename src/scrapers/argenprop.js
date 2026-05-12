import { fetchText, safeNumber } from './base.js';
import { logger } from '../logger.js';

const BASE = 'https://www.argenprop.com';

function buildUrl(neighborhood, operation, page) {
  const op = operation === 'venta' ? 'venta' : 'alquiler';
  const slug = neighborhood.id;
  const path = `/departamentos/${op}/${slug}`;
  const qs = page > 1 ? `?pagina-${page}` : '';
  return `${BASE}${path}${qs}`;
}

// Each card is anchored at `<a ... data-item-card="ID" ...>` and closes with `</a>` at the same depth.
// We split the document at the start of each card and take the chunk up to the next card start.
function splitCards(html) {
  const re = /<a\b[^>]*\bdata-item-card="(\d+)"[\s\S]*?(?=<a\b[^>]*\bdata-item-card="|<\/main>|<\/section>|<footer\b|$)/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ id: m[1], html: m[0] });
  }
  return out;
}

function attr(html, name) {
  const m = html.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function htmlDecode(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#xA;/g, '\n')
    .replace(/&#xB2;/g, '²')
    .replace(/&#xF1;/g, 'ñ')
    .replace(/&#xE1;/g, 'á')
    .replace(/&#xE9;/g, 'é')
    .replace(/&#xED;/g, 'í')
    .replace(/&#xF3;/g, 'ó')
    .replace(/&#xFA;/g, 'ú')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function parseFeatures(html) {
  // Each feature in <ul class="card__main-features"><li>...<span>VALUE</span></li>...</ul>
  const out = { covered_m2: null, age_years: null, bathrooms: null, rooms: null, total_m2: null };
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const text = stripTags(htmlDecode(m[1])).toLowerCase();
    const mM2Cub = text.match(/([\d.,]+)\s*m²?\s*cubie?/i);
    if (mM2Cub) out.covered_m2 = safeNumber(mM2Cub[1]);
    const mM2Tot = text.match(/([\d.,]+)\s*m²?\s*tot/i);
    if (mM2Tot) out.total_m2 = safeNumber(mM2Tot[1]);
    const mAge = text.match(/(\d+)\s*años?/i);
    if (mAge && /antig|años/i.test(text)) out.age_years = Number(mAge[1]);
    if (/a\s*estrenar|estreno/i.test(text)) out.age_years = 0;
    const mBath = text.match(/(\d+)\s*baño/i);
    if (mBath) out.bathrooms = Number(mBath[1]);
    const mAmb = text.match(/(\d+)\s*ambient/i);
    if (mAmb) out.rooms = Number(mAmb[1]);
    if (/monoambiente/i.test(text) && !out.rooms) out.rooms = 1;
  }
  return out;
}

// ArgenProp does NOT surface cochera in `card__main-features` for departamentos —
// only covered m², bedrooms and age make it there. So we infer from description
// text, but tighten the rule: only flag when the phrasing indicates the UNIT
// (not the building) has assigned parking.
function detectUnitGarage(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  // Explicit negatives short-circuit.
  if (/\bsin\s+cochera\b/.test(t)) return false;
  if (/\bno\s+(?:incluye|tiene)\s+cochera\b/.test(t)) return false;
  // Listings that are themselves cocheras for sale/rent.
  if (/\b(?:alquila|alquiler|venta|vende|vendo|en\s+venta)\b[^.]{0,30}\bcochera\b/.test(t)) return false;
  // Strong positives — phrasing indicates the unit owns/uses a parking spot.
  const positives = [
    /\bcochera\s+(?:fija|cubierta|descubierta|propia|incluida|asignada|opcional\s+incluida)\b/,
    /\bcon\s+cochera\b/,
    /\bincluye\s+cochera\b/,
    /\+\s*cochera\b/,
    /\b\d+\s+cocheras?\b/,
    /\bgarage\s+(?:propio|incluido|asignado)\b/,
    /\bc\/\s*cochera\b/, // "c/ cochera" abbreviation
  ];
  return positives.some((re) => re.test(t));
}

function parseFloor(addressText) {
  if (!addressText) return null;
  const m1 = addressText.match(/piso\s*([\d]{1,3})/i);
  if (m1) return m1[1];
  if (/planta\s+baja|\bP\.?B\.?\b/i.test(addressText)) return 'PB';
  return null;
}

function toListing(card, neighborhood, operation) {
  const html = card.html;
  const id = card.id;

  const hrefMatch = html.match(/<a\b[^>]*\bhref="([^"]+)"/);
  let url = hrefMatch ? hrefMatch[1] : null;
  if (url && !url.startsWith('http')) url = BASE + url;
  if (!url) return null;

  // The URL slug often encodes rooms: "...-1-ambiente--" or "...-3-ambientes--" or "...-monoambiente--".
  let urlRooms = null;
  const slugRoomsMatch = url.match(/-(\d+)-ambient/i);
  if (slugRoomsMatch) urlRooms = Number(slugRoomsMatch[1]);
  else if (/monoambiente/i.test(url)) urlRooms = 1;

  const idmoneda = attr(html, 'idmoneda');
  const monto = attr(html, 'montonormalizado');
  const dataMoneda = attr(html, 'data-moneda');
  const dataPrecio = attr(html, 'data-precio');
  const currency =
    dataMoneda || (idmoneda === '2' ? 'USD' : idmoneda === '1' ? 'ARS' : null);
  // Argenprop "Consultar precio" listings have montonormalizado="0" but may
  // still expose a residual data-precio value (cents from internal ranking).
  // If `monto` is 0 explicitly, the price is hidden — DON'T trust data-precio.
  const monto0 = monto === '0' || monto === '';
  const price = monto0 ? null : safeNumber(dataPrecio || monto);

  // Address with floor.
  const addressMatch = html.match(/class="card__address"[^>]*>([\s\S]*?)<\/p>/i);
  const addressRaw = addressMatch ? stripTags(htmlDecode(addressMatch[1])) : null;
  const floor = parseFloor(addressRaw);

  // Title / description.
  const titleMatch = html.match(/<h2\s+class="card__title"[^>]*>([\s\S]*?)<\/h2>/i);
  const infoMatch = html.match(/class="card__info[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const description = stripTags(
    htmlDecode((titleMatch?.[1] || '') + ' ' + (addressRaw || '') + ' ' + (infoMatch?.[1] || '')),
  ).slice(0, 1500);

  // Features.
  const feats = parseFeatures(html);

  const blob = description.toLowerCase();
  const has_pool = /pileta|piscina/i.test(blob);
  const has_garage = detectUnitGarage(blob);
  const has_amenities = /amenit|gimnasio|laundry|seguridad|sum\b/i.test(blob);

  return {
    source: 'argenprop',
    external_id: id,
    url,
    operation,
    city: null,
    neighborhood: neighborhood.id,
    neighborhood_raw: neighborhood.display,
    property_type: 'departamento',
    rooms: feats.rooms ?? urlRooms,
    bedrooms: null,
    bathrooms: feats.bathrooms,
    covered_m2: feats.covered_m2,
    uncovered_m2:
      Number.isFinite(feats.total_m2) &&
      Number.isFinite(feats.covered_m2) &&
      feats.total_m2 > feats.covered_m2
        ? feats.total_m2 - feats.covered_m2
        : null,
    total_m2: feats.total_m2,
    age_years: feats.age_years,
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
    description,
    raw: { address: addressRaw, idmoneda, monto },
  };
}

// Visit one ArgenProp listing's detail page and pull the structured features.
// The detail page is HTTP-fetchable (no JS needed) so this is fast.
//
// HTML shapes we exploit:
//   - <li><p>LABEL:<strong>VALUE</strong></p></li>     ← "Cant. Ambientes", "Sup. Total", etc.
//   - <li title="Antiguedad"><p class="strong">A Estrenar</p></li>
//   - <li title="Antiguedad">…<span>15 años</span>…</li>
export async function enrichDetail(url) {
  const full = url.startsWith('http') ? url : BASE + url;
  let html;
  try {
    html = await fetchText(full);
  } catch (err) {
    // Re-throw "gone" errors so the enrichment pipeline can deactivate the
    // listing instead of looping retries against a permanent 404/410.
    if (err.name === 'ListingGoneError') throw err;
    logger.warn({ err: err.message, url: full }, 'argenprop enrich fetch failed');
    return null;
  }
  const out = {};

  // Label → <strong>VALUE</strong>. Used for the "Características" and
  // "Superficie" boxes on the detail page.
  function labelStrong(labelRe) {
    const re = new RegExp(
      `${labelRe.source}\\s*:?\\s*<\\/p>?\\s*<strong[^>]*>\\s*([^<]+?)\\s*<\\/strong>|` +
        `${labelRe.source}\\s*:\\s*<strong[^>]*>\\s*([^<]+?)\\s*<\\/strong>|` +
        `${labelRe.source}\\s*:?\\s*<[^>]+>\\s*<strong[^>]*>\\s*([^<]+?)\\s*<\\/strong>`,
      'i',
    );
    const m = html.match(re);
    return m ? (m[1] || m[2] || m[3] || '').trim() : null;
  }

  // <li title="Antiguedad">…<p|span>VALUE</p|span></li>
  function fromTitleAttr(titleRe) {
    const re = new RegExp(
      `<li[^>]*title=["']${titleRe.source}["'][^>]*>[\\s\\S]{0,400}?<(?:p|span)[^>]*>\\s*([^<]+?)\\s*<\\/(?:p|span)>`,
      'i',
    );
    const m = html.match(re);
    return m ? m[1].trim() : null;
  }

  function decode(s) {
    if (!s) return s;
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&nbsp;/g, ' ');
  }

  function num(s) {
    if (s == null) return null;
    const t = decode(String(s));
    const m = t.match(/[\d.,]+/);
    if (!m) return null;
    let v = m[0];
    if (v.includes('.') && !v.includes(',')) {
      const parts = v.split('.');
      if (parts.slice(1).every((p) => p.length === 3)) v = v.replace(/\./g, '');
    } else if (v.includes(',') && !v.includes('.')) {
      v = v.replace(',', '.');
    } else if (v.includes('.') && v.includes(',')) {
      v = v.replace(/\./g, '').replace(',', '.');
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  const totalRaw = labelStrong(/Sup\.\s*Total/) || labelStrong(/Superficie\s*Total/);
  const cubRaw = labelStrong(/Sup\.\s*Cubierta/) || labelStrong(/Superficie\s*Cubierta/);
  const ambRaw = labelStrong(/Cant\.\s*Ambientes/) || labelStrong(/Ambientes/);
  const dormRaw = labelStrong(/Cant\.\s*Dormitorios/) || labelStrong(/Dormitorios/);
  const banRaw = labelStrong(/Cant\.\s*Ba(?:&#xF1;|ñ|n)os/) || labelStrong(/Ba(?:ñ|n)os/);
  const cochRaw = labelStrong(/Cant\.\s*Cocheras?/) || labelStrong(/Cocheras?/);
  const antRaw = fromTitleAttr(/Antig[üu]edad/) || labelStrong(/Antig[üu]edad/);

  const total_m2 = num(totalRaw);
  const covered_m2 = num(cubRaw);
  const rooms = num(ambRaw);
  const bedrooms = num(dormRaw);
  const bathrooms = num(banRaw);
  const parking = num(cochRaw);
  let age_years = num(antRaw);
  if (age_years == null && antRaw && /a\s*estrenar/i.test(decode(antRaw))) age_years = 0;

  if (Number.isFinite(total_m2)) out.total_m2 = total_m2;
  if (Number.isFinite(covered_m2)) out.covered_m2 = covered_m2;
  if (Number.isFinite(rooms)) out.rooms = rooms;
  if (Number.isFinite(bedrooms)) out.bedrooms = bedrooms;
  if (Number.isFinite(bathrooms)) out.bathrooms = bathrooms;
  if (Number.isFinite(parking)) out.parking = parking;
  if (Number.isFinite(age_years)) out.age_years = age_years;
  // Pull a plain-text version of the body so downstream re-evaluation
  // (status, financed price) can mine "ANTICIPO + CUOTAS" patterns that
  // the card preview truncates.
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ');
  if (bodyText) out.description = bodyText.slice(0, 6000);
  return out;
}

export async function* iterateListings(neighborhood, operation, _opts = {}) {
  let page = 1;
  let pagesWithoutResults = 0;
  // No hard page cap — break on empty pages or when a page returns no new
  // external_ids (some sites loop the last page when you go past the end).
  const seenIds = new Set();
  while (true) {
    const url = buildUrl(neighborhood, operation, page);
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      logger.warn({ err: err.message, url }, 'argenprop page failed');
      throw err;
    }

    const cards = splitCards(html);
    const all = cards.map((c) => toListing(c, neighborhood, operation)).filter(Boolean);
    const listings = all.filter((l) => !seenIds.has(l.external_id));
    for (const l of listings) seenIds.add(l.external_id);

    if (all.length === 0) {
      pagesWithoutResults++;
      if (pagesWithoutResults >= 2) break;
    } else {
      pagesWithoutResults = 0;
    }
    if (listings.length === 0 && all.length > 0) {
      logger.info(
        { page, total: all.length, neighborhood: neighborhood.id, operation },
        'argenprop: page returned no new listings — likely past the end',
      );
      break;
    }
    yield { page, listings, totalHint: null };
    page++;
  }
}
