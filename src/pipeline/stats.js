import { getDb } from '../db.js';
import { config } from '../config.js';

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(nums, p) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function roomsBucket(rooms) {
  if (rooms == null) return null;
  if (rooms >= 5) return '5+';
  return String(rooms);
}

// Premium outlier detection. We split off anything more than
// `OUTLIER_MEDIAN_MULTIPLIER` times the median as "premium tier" — these are
// real listings (Forum Alcorta etc) but their prices skew the headline
// median when typical inventory is much cheaper. Proportional to median
// (rather than Tukey's IQR) catches premium tier even in cells with wide
// IQR. Only applied when the sample is big enough (n≥10) that median is
// stable.
const OUTLIER_MIN_N = 10;
const OUTLIER_MEDIAN_MULTIPLIER = 1.5;

// Same physical listing published on multiple portals (argenprop + ML + zonaprop)
// shows up as separate rows but should count once. Cluster by neighborhood +
// rooms + homog_m2 (±5%) + price_usd (±3%) and keep one per cluster.
// Prefer the row with the source slug that comes first alphabetically so the
// choice is deterministic.
function dedupListings(rows) {
  const clusters = [];
  for (const r of rows) {
    if (r.homogenized_m2 == null || r.price_usd == null || r.rooms == null) {
      clusters.push([r]);
      continue;
    }
    const c = clusters.find((cluster) => {
      const s = cluster[0];
      return (
        s.neighborhood === r.neighborhood &&
        s.rooms === r.rooms &&
        s.homogenized_m2 != null &&
        s.price_usd != null &&
        Math.abs(s.homogenized_m2 - r.homogenized_m2) / Math.max(s.homogenized_m2, r.homogenized_m2) < 0.05 &&
        Math.abs(s.price_usd - r.price_usd) / Math.max(s.price_usd, r.price_usd) < 0.03
      );
    });
    if (c) c.push(r);
    else clusters.push([r]);
  }
  return clusters.map((c) => {
    if (c.length === 1) return c[0];
    // Deterministic pick: lowest source name alphabetically. Helps debugging.
    return [...c].sort((a, b) => (a.source || '').localeCompare(b.source || ''))[0];
  });
}

function describe(rows) {
  // `rows` can be either an array of plain numbers (legacy) or an array of
  // { price, source } objects. Sources are bucketed when present so the UI
  // can show a per-source breakdown next to n=.
  const isObj = rows.length > 0 && typeof rows[0] === 'object';
  const allPrices = isObj ? rows.map((r) => r.price) : rows;
  if (allPrices.length < config.minStatsSamples) {
    const bs = {};
    if (isObj) for (const r of rows) bs[r.source || 'unknown'] = (bs[r.source || 'unknown'] || 0) + 1;
    return {
      n: allPrices.length,
      median: null,
      mean: null,
      p25: null,
      p75: null,
      by_source: isObj ? bs : undefined,
      outliers: null,
    };
  }
  // Split off premium outliers when we have enough data. Headline stats
  // describe the "typical" listing; outliers are reported separately so the
  // user knows what was excluded and at what price band.
  // Threshold = OUTLIER_MEDIAN_MULTIPLIER × median. Proportional to the
  // typical value of the cell — catches premium tier (Forum Alcorta etc.)
  // even when the IQR is wide. Anything > 1.5x the median for that
  // neighborhood/age/rooms is "premium" relative to the rest.
  let kept = rows;
  let outliers = null;
  if (allPrices.length >= OUTLIER_MIN_N) {
    const m = median(allPrices);
    const threshold = m * OUTLIER_MEDIAN_MULTIPLIER;
    const keptArr = [];
    const outArr = [];
    for (const r of rows) {
      const p = isObj ? r.price : r;
      (p > threshold ? outArr : keptArr).push(r);
    }
    if (outArr.length > 0) {
      const outPrices = isObj ? outArr.map((r) => r.price) : outArr;
      outliers = {
        count: outArr.length,
        min: round2(Math.min(...outPrices)),
        max: round2(Math.max(...outPrices)),
        mean: round2(mean(outPrices)),
        threshold: round2(threshold),
      };
      kept = keptArr;
    }
  }
  const keptPrices = isObj ? kept.map((r) => r.price) : kept;
  const bySource = {};
  if (isObj) {
    for (const r of kept) {
      const k = r.source || 'unknown';
      bySource[k] = (bySource[k] || 0) + 1;
    }
  }
  return {
    n: keptPrices.length,
    median: round2(median(keptPrices)),
    mean: round2(mean(keptPrices)),
    p25: round2(percentile(keptPrices, 25)),
    p75: round2(percentile(keptPrices, 75)),
    by_source: isObj ? bySource : undefined,
    outliers,
  };
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function pricePerM2(row) {
  if (!row.price_usd || !row.homogenized_m2) return null;
  return row.price_usd / row.homogenized_m2;
}

function applyFiltersToRows(rows, filters = {}) {
  let out = rows;
  if (filters.require_pool) out = out.filter((r) => r.has_pool === 1);
  if (filters.require_garage) out = out.filter((r) => r.has_garage === 1);
  if (filters.min_rooms != null) out = out.filter((r) => (r.rooms ?? 0) >= filters.min_rooms);
  if (filters.max_rooms != null) out = out.filter((r) => (r.rooms ?? Infinity) <= filters.max_rooms);
  // include_pozo / include_construccion: when false (default), exclude those statuses.
  if (!filters.include_pozo) out = out.filter((r) => r.status !== 'en-pozo');
  if (!filters.include_construccion) out = out.filter((r) => r.status !== 'construccion');
  return out;
}

export function computeStatsForNeighborhood(neighborhood, filters = {}) {
  const db = getDb();
  const all = db
    .prepare(
      `SELECT source, rooms, has_pool, has_garage, age_band, status, price_usd, homogenized_m2
       FROM listings
       WHERE neighborhood = ? AND operation = 'venta' AND active = 1
         AND price_usd > 0 AND homogenized_m2 > 0`,
    )
    .all(neighborhood);
  // Dedup cross-portal: same physical apartment listed on argenprop + ML +
  // zonaprop counts once. See `dedupListings` for the matching rule.
  const filtered = applyFiltersToRows(all, filters);
  const rows = dedupListings(filtered);

  const byStatus = {
    disponible: [],
    'en-pozo': [],
    construccion: [],
  };
  const disponibleByRooms = {};
  const disponibleWithPool = [];
  const matrixAgeRooms = {}; // age_band -> rooms_bucket -> [{price, source}]

  for (const r of rows) {
    const p = pricePerM2(r);
    if (p == null) continue;
    const entry = { price: p, source: r.source };
    const status = r.status in byStatus ? r.status : 'disponible';
    byStatus[status].push(entry);
    if (status !== 'disponible') continue;

    const bucket = roomsBucket(r.rooms);
    if (bucket) {
      (disponibleByRooms[bucket] ??= []).push(entry);
    }
    if (r.has_pool === 1) disponibleWithPool.push(entry);

    const age = r.age_band || 'unknown';
    if (bucket) {
      const m = (matrixAgeRooms[age] ??= {});
      (m[bucket] ??= []).push(entry);
    }
  }

  const usdPerM2 = {
    disponible: describe(byStatus.disponible),
    en_pozo: describe(byStatus['en-pozo']),
    construccion: describe(byStatus.construccion),
  };
  const byRooms = {};
  for (const [bucket, arr] of Object.entries(disponibleByRooms)) {
    byRooms[bucket] = describe(arr);
  }
  const withPool = describe(disponibleWithPool);
  const ageXRooms = {};
  for (const [age, byRoom] of Object.entries(matrixAgeRooms)) {
    ageXRooms[age] = {};
    for (const [bucket, arr] of Object.entries(byRoom)) {
      ageXRooms[age][bucket] = describe(arr);
    }
  }

  // Build the parallel "monthly rent" matrix (alquiler) — rooms × age_band,
  // median USD/month. Helps the user gauge what a unit of a given size+age
  // would rent for in this neighborhood.
  const rentRowsRaw = db
    .prepare(
      `SELECT source, rooms, age_band, price_usd, homogenized_m2, neighborhood
       FROM listings
       WHERE neighborhood = ? AND operation = 'alquiler' AND active = 1
         AND price_usd > 0 AND price_usd < 5000`,
    )
    .all(neighborhood);
  // Same dedup as venta: a 3-amb in Forum Alcorta posted to 4 portals at
  // $2.800/mes should count once, not four times.
  const rentRows = dedupListings(rentRowsRaw);
  const rentMatrix = {};
  for (const r of rentRows) {
    const bucket = roomsBucket(r.rooms);
    if (!bucket) continue;
    const age = r.age_band || 'unknown';
    const m = (rentMatrix[age] ??= {});
    (m[bucket] ??= []).push({ price: r.price_usd, source: r.source });
  }
  const rentByAgeRooms = {};
  for (const [age, byRoom] of Object.entries(rentMatrix)) {
    rentByAgeRooms[age] = {};
    for (const [bucket, arr] of Object.entries(byRoom)) {
      rentByAgeRooms[age][bucket] = describe(arr);
    }
  }

  return {
    neighborhood,
    sample_total: rows.length,
    usd_per_m2: usdPerM2,
    by_rooms: byRooms,
    with_pool: withPool,
    age_x_rooms: ageXRooms,
    rent_age_x_rooms: rentByAgeRooms,
  };
}

export function computeAggregate(neighborhoods, filters = {}) {
  // Re-uses computeStatsForNeighborhood per neighborhood and also a combined view.
  const db = getDb();
  const all = db
    .prepare(
      `SELECT source, rooms, has_pool, has_garage, age_band, status, price_usd, homogenized_m2, neighborhood
       FROM listings
       WHERE neighborhood IN (${neighborhoods.map(() => '?').join(',')})
         AND operation = 'venta' AND active = 1
         AND price_usd > 0 AND homogenized_m2 > 0`,
    )
    .all(...neighborhoods);
  const filtered = applyFiltersToRows(all, filters);
  const rows = dedupListings(filtered);
  const allEntries = [];
  const dispEntries = [];
  for (const r of rows) {
    const price = pricePerM2(r);
    if (price == null) continue;
    const e = { price, source: r.source };
    allEntries.push(e);
    if (r.status === 'disponible') dispEntries.push(e);
  }
  return {
    neighborhoods,
    sample_total: rows.length,
    usd_per_m2_disponible: describe(dispEntries),
    usd_per_m2_all: describe(allEntries),
  };
}

// Audit helper: return the actual listings for a single matrix cell, split
// into "kept" (used in the median) and "outliers" (excluded as premium),
// both sorted by price. Lets the user inspect why a cell got the value it did.
//
// IMPORTANT: dedup runs over ALL the neighborhood's listings (not just this
// cell) to mirror what computeStatsForNeighborhood does — otherwise the
// kept/outlier counts diverge from what the matrix headline shows.
export function getCellListings({ neighborhood, matrix, age, rooms, filters = {} }) {
  const db = getDb();
  let all;
  if (matrix === 'alquiler') {
    all = db
      .prepare(
        `SELECT source, external_id, url, rooms, age_band, age_years, price_usd, currency, price,
                covered_m2, uncovered_m2, total_m2, homogenized_m2, has_garage, has_pool, neighborhood
         FROM listings
         WHERE neighborhood = ? AND operation = 'alquiler' AND active = 1
           AND price_usd > 0 AND price_usd < 5000`,
      )
      .all(neighborhood);
  } else {
    const raw = db
      .prepare(
        `SELECT source, external_id, url, rooms, age_band, age_years, price_usd, currency, price,
                covered_m2, uncovered_m2, total_m2, homogenized_m2, has_garage, has_pool, status, neighborhood
         FROM listings
         WHERE neighborhood = ? AND operation = 'venta' AND active = 1
           AND status = 'disponible'
           AND price_usd > 0 AND homogenized_m2 > 0`,
      )
      .all(neighborhood);
    all = applyFiltersToRows(raw, filters);
  }
  // Dedup over the full neighborhood set, then filter down to the cell.
  const deduped = dedupListings(all);
  let rows = deduped.filter((r) => {
    const matchesAge = age === 'unknown' ? r.age_band == null : r.age_band === age;
    const matchesRooms = rooms === '5+' ? r.rooms >= 5 : r.rooms === Number(rooms);
    return matchesAge && matchesRooms;
  });
  // Compute the metric the matrix cell uses (USD/m² for venta, USD/mes for alquiler).
  const withMetric = rows
    .map((r) => {
      const metric = matrix === 'alquiler' ? r.price_usd : r.price_usd / r.homogenized_m2;
      return { ...r, metric };
    })
    .filter((r) => Number.isFinite(r.metric))
    .sort((a, b) => b.metric - a.metric); // desc, top first

  // Apply the same outlier rule as describe(): > 1.5x median when n>=10.
  let threshold = null;
  if (withMetric.length >= 10) {
    const m = median(withMetric.map((r) => r.metric));
    threshold = m * 1.5;
  }
  const kept = [];
  const outliers = [];
  for (const r of withMetric) {
    if (threshold != null && r.metric > threshold) outliers.push(r);
    else kept.push(r);
  }
  return {
    neighborhood,
    matrix,
    age,
    rooms,
    threshold: threshold != null ? round2(threshold) : null,
    median_kept: kept.length ? round2(median(kept.map((r) => r.metric))) : null,
    kept,
    outliers,
  };
}
