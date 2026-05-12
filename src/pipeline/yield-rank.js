import { getDb } from '../db.js';
import { estimateRent, medianAEstrenarPerM2 } from './rent-match.js';

const SELECT_VENTAS = `
SELECT id, source, external_id, url, neighborhood, neighborhood_raw, rooms, bedrooms, bathrooms,
       covered_m2, uncovered_m2, total_m2, homogenized_m2, age_years, age_band,
       has_pool, has_amenities, has_garage, floor, amenities_json,
       price, currency, price_usd, status, delivery_year
FROM listings
WHERE operation = 'venta' AND neighborhood IN ({{ph}}) AND active = 1
  AND price_usd > 0 AND homogenized_m2 > 0
`;

export function rankProperties({
  neighborhoods,
  includePozo = false,
  includeConstruccion = false,
  minYield = 0.05,
  minBuildYield = 0.05,
  minRooms = null,
  maxRooms = null,
  requirePool = false,
  requireGarage = false,
  sort = 'score',
}) {
  if (!neighborhoods?.length) return [];
  const db = getDb();
  const ph = neighborhoods.map(() => '?').join(',');
  const rows = db.prepare(SELECT_VENTAS.replace('{{ph}}', ph)).all(...neighborhoods);

  const ranked = [];
  for (const r of rows) {
    if (minRooms != null && (r.rooms ?? 0) < minRooms) continue;
    if (maxRooms != null && (r.rooms ?? Infinity) > maxRooms) continue;
    if (requirePool && r.has_pool !== 1) continue;
    if (requireGarage && r.has_garage !== 1) continue;

    const isPozo = r.status === 'en-pozo';
    const isConstr = r.status === 'construccion';
    if (isPozo && !includePozo) continue;
    if (isConstr && !includeConstruccion) continue;

    let rental_yield_pct = null;
    let build_yield_pct = null;
    let rent_estimate_usd = null;
    let rent_source = null;
    let ref_usd_per_m2 = null;
    let build_ref_source = null;

    if (r.status === 'disponible') {
      const rent = estimateRent(r);
      rent_estimate_usd = rent.estimateUsd;
      rent_source = rent.source;
      rental_yield_pct = (rent.estimateUsd * 12) / r.price_usd;
      if (rental_yield_pct < minYield) continue;
    } else {
      const ref = medianAEstrenarPerM2(r);
      ref_usd_per_m2 = ref.value;
      build_ref_source = ref.source;
      if (ref.value == null) continue;
      const myPerM2 = r.price_usd / r.homogenized_m2;
      build_yield_pct = (ref.value - myPerM2) / myPerM2;
      if (build_yield_pct < minBuildYield) continue;
    }

    const score = Math.max(rental_yield_pct ?? -Infinity, build_yield_pct ?? -Infinity);

    ranked.push({
      id: r.id,
      source: r.source,
      external_id: r.external_id,
      url: r.url,
      neighborhood: r.neighborhood,
      rooms: r.rooms,
      bedrooms: r.bedrooms,
      bathrooms: r.bathrooms,
      covered_m2: r.covered_m2,
      uncovered_m2: r.uncovered_m2,
      total_m2: r.total_m2,
      homogenized_m2: r.homogenized_m2,
      age_years: r.age_years,
      age_band: r.age_band,
      has_pool: r.has_pool === 1,
      has_amenities: r.has_amenities === 1,
      has_garage: r.has_garage === 1,
      floor: r.floor,
      amenities: safeJson(r.amenities_json),
      price: r.price,
      currency: r.currency,
      price_usd: r.price_usd,
      price_usd_per_m2: round2(r.price_usd / r.homogenized_m2),
      status: r.status,
      delivery_year: r.delivery_year,
      rental_yield_pct: round4(rental_yield_pct),
      build_yield_pct: round4(build_yield_pct),
      rent_estimate_usd: round2(rent_estimate_usd),
      rent_source,
      ref_usd_per_m2: round2(ref_usd_per_m2),
      build_ref_source,
      score: round4(score),
    });
  }

  const cmp = sortComparator(sort);
  ranked.sort(cmp);
  return dedupe(ranked);
}

function sortComparator(sort) {
  switch (sort) {
    case 'price_usd':
      return (a, b) => (a.price_usd ?? 0) - (b.price_usd ?? 0);
    case 'price_usd_desc':
      return (a, b) => (b.price_usd ?? 0) - (a.price_usd ?? 0);
    case 'usd_per_m2':
      return (a, b) => (a.price_usd_per_m2 ?? 0) - (b.price_usd_per_m2 ?? 0);
    case 'score':
    default:
      return (a, b) => (b.score ?? 0) - (a.score ?? 0);
  }
}

function dedupe(list) {
  // Only collapse rows that are very likely the SAME physical unit posted on
  // different portals. Strict requirements:
  //   - Distinct source (two listings on the same portal are different units).
  //   - Same neighborhood + rooms + age band (when known).
  //   - Price within ±0.5% (or ±$200, whichever larger).
  //   - Homogenized m² within ±1% (or ±1.5 m², whichever larger).
  const groups = [];
  for (const item of list) {
    const match = groups.find((g) => {
      if (g.some((existing) => existing.source === item.source)) return false;
      const ref = g[0];
      if (ref.neighborhood !== item.neighborhood) return false;
      if (ref.rooms !== item.rooms) return false;
      if (ref.age_band && item.age_band && ref.age_band !== item.age_band) return false;
      if (ref.homogenized_m2 == null || item.homogenized_m2 == null) return false;
      const m2Diff = Math.abs(ref.homogenized_m2 - item.homogenized_m2);
      if (m2Diff > 1.5 && m2Diff / ref.homogenized_m2 > 0.01) return false;
      if (ref.price_usd == null || item.price_usd == null) return false;
      const pDiff = Math.abs(ref.price_usd - item.price_usd);
      if (pDiff > 200 && pDiff / ref.price_usd > 0.005) return false;
      return true;
    });
    if (match) match.push(item);
    else groups.push([item]);
  }
  return groups.map((g) => {
    if (g.length === 1) return g[0];
    const primary = g[0];
    primary.duplicates = g.slice(1).map((d) => ({ source: d.source, url: d.url }));
    return primary;
  });
}

function safeJson(s) {
  try {
    return JSON.parse(s || '[]');
  } catch {
    return [];
  }
}
function round2(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}
function round4(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000;
}
