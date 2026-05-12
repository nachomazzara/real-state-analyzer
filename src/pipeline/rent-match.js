import { readFileSync } from 'node:fs';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

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

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fetchRentals({ neighborhood, rooms, age_band, has_pool, has_garage }) {
  const db = getDb();
  const wheres = [
    'operation = ?',
    'neighborhood = ?',
    'active = 1',
    'price_usd > 0',
    'homogenized_m2 > 0',
  ];
  const params = ['alquiler', neighborhood];
  if (rooms != null) {
    wheres.push('rooms = ?');
    params.push(rooms);
  }
  if (age_band) {
    wheres.push('age_band = ?');
    params.push(age_band);
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
    .prepare(`SELECT price_usd FROM listings WHERE ${wheres.join(' AND ')}`)
    .all(...params)
    .map((r) => r.price_usd);
}

function fallbackRate(neighborhood, rooms) {
  const fb = getFallback();
  const table = fb[neighborhood] || fb.default;
  const r = rooms != null ? Math.min(5, Math.max(1, Math.round(rooms))) : 2;
  const v = table?.[String(r)] ?? fb.default?.[String(r)] ?? 7;
  return v;
}

export function estimateRent(listing) {
  // Simple rule: average price of comparable rentals (same neighborhood,
  // same room count, same age band, same amenities). No per-m² math, no
  // outlier cutoffs — that is the scrapers' job to keep the data clean.
  // Relax filters in steps if we don't have enough matches.
  const base = {
    neighborhood: listing.neighborhood,
    rooms: listing.rooms,
    age_band: listing.age_band,
    has_pool: listing.has_pool,
    has_garage: listing.has_garage,
  };
  const tries = [
    base,
    { ...base, has_pool: null, has_garage: null },
    { ...base, age_band: null, has_pool: null, has_garage: null },
    { neighborhood: base.neighborhood, rooms: base.rooms },
    { neighborhood: base.neighborhood },
  ];

  for (const f of tries) {
    const prices = fetchRentals(f);
    if (prices.length >= MIN_MATCHES) {
      return {
        estimateUsd: mean(prices),
        n: prices.length,
        source: 'scraped',
      };
    }
  }

  // Not enough comparables: fall back to the seed table (USD/m²/month per
  // neighborhood × room count). This is the only place where we resort to a
  // per-m² figure, and it's clearly labeled as `fallback`.
  const rate = fallbackRate(listing.neighborhood, listing.rooms);
  return {
    estimateUsd: rate * (listing.homogenized_m2 || 0),
    n: 0,
    source: 'fallback',
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
