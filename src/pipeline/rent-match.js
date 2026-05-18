import { readFileSync } from 'node:fs';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { neighborCells } from './subzone.js';
import { sizeBucket, SIZE_BUCKET_FILTERS } from './size-bucket.js';

// Minimum number of comparable rentals to compute an estimate from real data.
// Below this we fall back to the manual table in data/rent-fallback.json.
const MIN_MATCHES = 3;

let fallbackCache = null;
function getFallback() {
  if (fallbackCache) return fallbackCache;
  try {
    const raw = readFileSync(config.rentFallbackPath, 'utf8');
    fallbackCache = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err: err.message }, 'rent fallback unavailable');
    fallbackCache = { default: { 1: 7, 2: 7, 3: 7, 4: 7, 5: 7 } };
  }
  return fallbackCache;
}

function median(nums) {
  if (!nums.length) return null;
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function fetchRentals({ neighborhood, sub_zone, sub_zone_set, rooms, age_band, has_pool, has_garage, m2_min, m2_max, rooms_gte, property_type_in }) {
  const db = getDb();
  const wheres = [
    'operation = ?',
    'neighborhood = ?',
    'active = 1',
    'price_usd > 0',
    'homogenized_m2 > 0',
  ];
  const params = ['alquiler', neighborhood];
  // Accept either a single sub_zone OR a list (sub_zone_set) so the cascade
  // can probe "this cell + its H3 neighbors" as a middle tier between strict
  // sub-zone and neighborhood-wide.
  if (sub_zone_set && sub_zone_set.length > 0) {
    const ph = sub_zone_set.map(() => '?').join(',');
    wheres.push(`sub_zone IN (${ph})`);
    params.push(...sub_zone_set);
  } else if (sub_zone) {
    wheres.push('sub_zone = ?');
    params.push(sub_zone);
  }
  if (rooms != null) {
    wheres.push('rooms = ?');
    params.push(rooms);
  }
  if (rooms_gte != null) {
    wheres.push('rooms >= ?');
    params.push(rooms_gte);
  }
  if (age_band) {
    wheres.push('age_band = ?');
    params.push(age_band);
  }
  // Size-bucket m² range. m2_min is inclusive, m2_max is exclusive — matches
  // the bucket boundaries (e.g. "2-normal" = [50, 70) m²).
  if (m2_min != null) {
    wheres.push('homogenized_m2 >= ?');
    params.push(m2_min);
  }
  if (m2_max != null) {
    wheres.push('homogenized_m2 < ?');
    params.push(m2_max);
  }
  if (property_type_in && property_type_in.length > 0) {
    const ph = property_type_in.map(() => '?').join(',');
    wheres.push(`lower(property_type) IN (${ph})`);
    params.push(...property_type_in.map((s) => s.toLowerCase()));
  }
  if (has_pool != null) {
    wheres.push('has_pool = ?');
    params.push(has_pool);
  }
  if (has_garage != null) {
    wheres.push('has_garage = ?');
    params.push(has_garage);
  }
  return db
    .prepare(`SELECT price_usd, homogenized_m2 FROM listings WHERE ${wheres.join(' AND ')}`)
    .all(...params);
}

// Address normalization for substring matching against sub-zone labels.
function normalizeText(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Infer a sub_zone for a listing that has no coords but does have an address.
// We score each sub_zone_label in the barrio by how many of its top streets
// appear in the listing's address (substring match, accent-stripped, lower-
// case). The best-scoring sub_zone wins. Returns null if no label has any
// street in the address (we'd rather show nothing than mislead).
function inferSubZoneFromAddress(listing) {
  if (!listing.address || !listing.neighborhood) return null;
  const addr = normalizeText(listing.address);
  if (addr.length < 4) return null;
  const db = getDb();
  const labels = db
    .prepare('SELECT sub_zone, label FROM sub_zone_labels WHERE neighborhood = ?')
    .all(listing.neighborhood);
  let best = null;
  let bestScore = 0;
  for (const row of labels) {
    // Labels look like "Calle A & Calle B" or "Av. del Libertador (Núñez)".
    // Split on "&" and parens to get the candidate street tokens.
    const tokens = row.label
      .split(/\s+&\s+|\s*\([^)]*\)\s*/)
      .map((t) => normalizeText(t))
      .filter((t) => t.length >= 4);
    let score = 0;
    for (const t of tokens) {
      if (addr.includes(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = row.sub_zone;
    }
  }
  return best;
}

// Sub-zone anchored estimate: the median rent/m² of ALL rentals in the
// listing's own sub_zone (or its ring-1 neighbors), with NO room/age/size
// filters. We only call this when the regular cascade fell through to
// "neighborhood" or "fallback" — to give the user a "if we just averaged
// everything in your sub-zone, you'd pay $X" reference next to the
// barrio-wide estimate.
//
// When the listing has no sub_zone but does have an address, we infer the
// sub_zone from the address (matching its streets against sub-zone labels).
// Returns null when there's no sub-zone signal at all.
function subzoneAnchoredEstimate(listing) {
  let subZone = listing.sub_zone;
  let inferred = false;
  if (!subZone) {
    subZone = inferSubZoneFromAddress(listing);
    if (subZone) inferred = true;
  }
  if (!subZone || !listing.neighborhood) return null;
  const db = getDb();
  const tryQuery = (zoneSet) => {
    const ph = zoneSet.map(() => '?').join(',');
    return db
      .prepare(`SELECT price_usd, homogenized_m2 FROM listings
                WHERE operation='alquiler' AND active=1 AND price_usd>0 AND homogenized_m2>0
                  AND neighborhood=? AND sub_zone IN (${ph})`)
      .all(listing.neighborhood, ...zoneSet);
  };
  let rows = tryQuery([subZone]);
  let scope = inferred ? 'inferred' : 'own';
  if (rows.length < MIN_MATCHES) {
    // Expand to ring-1 neighbors (corridors graceful-fail to empty set).
    const expanded = [subZone, ...neighborCells(subZone, 1)];
    rows = tryQuery(expanded);
    if (!inferred) scope = 'ring1';
  }
  if (rows.length < MIN_MATCHES) return null;
  const rates = rows.map((r) => r.price_usd / r.homogenized_m2);
  const med = median(rates);
  // Light outlier trim when n is large (mirrors estimateRent's behavior).
  const kept = rates.length >= 10 ? rates.filter((r) => r <= med * 1.5) : rates;
  const rate = median(kept);
  const m2 = listing.homogenized_m2 || 0;
  return {
    estimateUsd: rate * m2,
    ratePerM2: rate,
    n: kept.length,
    scope, // 'own' | 'ring1' | 'inferred'
    subZoneLabel: lookupSubZoneLabel(subZone, listing.neighborhood),
  };
}

function lookupSubZoneLabel(subZone, neighborhood) {
  if (!subZone) return null;
  // The same H3 cell can appear in two barrios (res-8 cells are ~460m wide
  // and may straddle borders). With the composite PK we need both keys to
  // pick the right label; fall back to any matching row if neighborhood
  // wasn't supplied by the caller.
  const db = getDb();
  if (neighborhood) {
    const row = db
      .prepare('SELECT label FROM sub_zone_labels WHERE sub_zone = ? AND neighborhood = ?')
      .get(subZone, neighborhood);
    if (row) return row.label;
  }
  const row = db
    .prepare('SELECT label FROM sub_zone_labels WHERE sub_zone = ? LIMIT 1')
    .get(subZone);
  return row?.label || null;
}

function fallbackRate(neighborhood, rooms) {
  const fb = getFallback();
  const table = fb[neighborhood] || fb.default;
  const r = rooms != null ? Math.min(5, Math.max(1, Math.round(rooms))) : 2;
  const v = table?.[String(r)] ?? fb.default?.[String(r)] ?? 7;
  return v;
}

export function estimateRent(listing) {
  // Rate-based estimate: median(rent / m²) of comparable rentals × this
  // listing's homogenized_m2. We try the tightest match first (same sub-zone
  // + rooms + age + amenities + same size bucket) and progressively relax
  // until we hit MIN_MATCHES, so the most-specific reference wins.
  //
  // Size bucket (chico/normal/grande within each rooms count) is enforced
  // through the WHOLE cascade — never average a 2-amb 100m² with a 2-amb
  // 45m². Only the final fallback to neighborhood-without-anything skips it.
  const sBucket = sizeBucket(listing.rooms, listing.homogenized_m2, listing.property_type);
  const sizeFilter = sBucket ? SIZE_BUCKET_FILTERS[sBucket] : null;
  const sizeSlice = sizeFilter ? {
    m2_min: sizeFilter.m2_min,
    m2_max: sizeFilter.m2_max,
    rooms_gte: sizeFilter.rooms_gte ?? null,
    property_type_in: sizeFilter.property_type_in || null,
  } : {};
  // When the size filter pins an explicit rooms_eq (most buckets do), it
  // matches listing.rooms by construction. For "4+" we use rooms_gte and
  // drop the rooms_eq so the cascade catches 4, 5, 6 amb together.
  const baseRooms = sizeFilter && sizeFilter.rooms_gte != null ? null : listing.rooms;
  const base = {
    neighborhood: listing.neighborhood,
    sub_zone: listing.sub_zone || null,
    rooms: baseRooms,
    age_band: listing.age_band,
    has_pool: listing.has_pool,
    has_garage: listing.has_garage,
    ...sizeSlice,
  };
  // Cascade: sub-zone matches FIRST (when the listing has a sub_zone), then
  // sub-zone-expanded (the cell + its H3 ring-1 neighbors), then
  // neighborhood-level. Each layer relaxes amenities/age in turn.
  const subZoneTries = base.sub_zone ? [
    base,
    { ...base, has_pool: null, has_garage: null },
    { ...base, age_band: null, has_pool: null, has_garage: null },
    { neighborhood: base.neighborhood, sub_zone: base.sub_zone, rooms: base.rooms, ...sizeSlice },
  ] : [];
  // Expanded tier: the listing's cell plus all H3 neighbors at ring 1 (6
  // adjacent hexes). Gives us a "this corner of the barrio" window that's
  // broader than a single cell but still sub-neighborhood — a useful middle
  // ground when the exact sub-zone has too few comparables.
  const expandedSet = base.sub_zone
    ? [base.sub_zone, ...neighborCells(base.sub_zone, 1)]
    : null;
  const expandedTries = expandedSet ? [
    { neighborhood: base.neighborhood, sub_zone_set: expandedSet, rooms: base.rooms, age_band: base.age_band, has_pool: base.has_pool, has_garage: base.has_garage, ...sizeSlice },
    { neighborhood: base.neighborhood, sub_zone_set: expandedSet, rooms: base.rooms, age_band: base.age_band, ...sizeSlice },
    { neighborhood: base.neighborhood, sub_zone_set: expandedSet, rooms: base.rooms, ...sizeSlice },
  ] : [];
  const neighborhoodTries = [
    { neighborhood: base.neighborhood, rooms: base.rooms, age_band: base.age_band, has_pool: base.has_pool, has_garage: base.has_garage, ...sizeSlice },
    { neighborhood: base.neighborhood, rooms: base.rooms, age_band: base.age_band, ...sizeSlice },
    { neighborhood: base.neighborhood, rooms: base.rooms, ...sizeSlice },
    // Final relax: drop size constraint at neighborhood level. Less precise
    // (mixes 2-amb chico/normal/grande), but better than the static fallback.
    { neighborhood: base.neighborhood, rooms: listing.rooms },
  ];

  const targetM2 = listing.homogenized_m2;
  const allTries = [
    ...subZoneTries.map((f) => ({ filter: f, level: 'subzone' })),
    ...expandedTries.map((f) => ({ filter: f, level: 'subzone-expanded' })),
    ...neighborhoodTries.map((f) => ({ filter: f, level: 'neighborhood' })),
  ];

  for (const { filter, level } of allTries) {
    const rows = fetchRentals(filter);
    if (rows.length >= MIN_MATCHES) {
      const rates = rows.map((r) => r.price_usd / r.homogenized_m2);
      const med = median(rates);
      const kept = rates.length >= 10 ? rates.filter((r) => r <= med * 1.5) : rates;
      const finalRate = median(kept);
      const estimateUsd =
        targetM2 != null && targetM2 > 0 ? finalRate * targetM2 : finalRate * (median(rows.map((r) => r.homogenized_m2)) || 0);
      const isSubzoneLevel = level === 'subzone' || level === 'subzone-expanded';
      // When the cascade fell to barrio-wide, also try a sub-zone anchored
      // estimate (all rentals in the listing's hex, no filters). Lets the UI
      // show "if we averaged only your zone you'd pay $X" alongside the
      // barrio fallback. Skipped when the primary match already used the
      // sub-zone.
      const subzoneAlt = isSubzoneLevel ? null : subzoneAnchoredEstimate(listing);
      return {
        estimateUsd,
        ratePerM2: finalRate,
        n: kept.length,
        source: 'scraped',
        matchLevel: level, // 'subzone' | 'subzone-expanded' | 'neighborhood'
        subZone: isSubzoneLevel ? base.sub_zone : null,
        subZoneLabel: isSubzoneLevel ? lookupSubZoneLabel(base.sub_zone, base.neighborhood) : null,
        sizeBucket: sBucket,
        subzoneAlt,
      };
    }
  }

  // Not enough comparables: fall back to the seed table (USD/m²/month per
  // neighborhood × room count). Still try the sub-zone anchored alternative
  // so the user has a "if we just averaged the zone" reference next to it.
  const rate = fallbackRate(listing.neighborhood, listing.rooms);
  return {
    estimateUsd: rate * (listing.homogenized_m2 || 0),
    ratePerM2: rate,
    n: 0,
    source: 'fallback',
    matchLevel: 'fallback',
    subZone: null,
    subZoneLabel: null,
    sizeBucket: sBucket,
    subzoneAlt: subzoneAnchoredEstimate(listing),
  };
}

export function medianAEstrenarPerM2(listing) {
  const db = getDb();
  const wheres = [
    "operation = 'venta'",
    "status = 'disponible'",
    "age_band = 'a-estrenar'",
    'neighborhood = ?',
    'rooms = ?',
    'active = 1',
    'price_usd > 0',
    'homogenized_m2 > 0',
  ];
  const params = [listing.neighborhood, listing.rooms];

  function query(extra = {}) {
    const w = [...wheres];
    const p = [...params];
    if (extra.has_pool != null) {
      w.push('has_pool = ?');
      p.push(extra.has_pool);
    }
    if (extra.has_garage != null) {
      w.push('has_garage = ?');
      p.push(extra.has_garage);
    }
    return db
      .prepare(`SELECT price_usd, homogenized_m2 FROM listings WHERE ${w.join(' AND ')}`)
      .all(...p);
  }

  const tries = [
    { has_pool: listing.has_pool, has_garage: listing.has_garage },
    { has_pool: listing.has_pool },
    {},
  ];
  for (const t of tries) {
    const rows = query(t);
    if (rows.length >= MIN_MATCHES) {
      const arr = rows.map((r) => r.price_usd / r.homogenized_m2);
      // median (still ok for build-yield since these are all sale listings)
      arr.sort((a, b) => a - b);
      const mid = Math.floor(arr.length / 2);
      const med = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
      return { value: med, n: rows.length, source: 'scraped' };
    }
  }
  return { value: null, n: 0, source: 'insufficient' };
}
