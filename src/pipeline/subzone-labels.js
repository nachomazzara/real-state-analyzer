import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { neighborCells } from './subzone.js';

// Minimum listings for a cell to stand on its own. Below this we try to merge
// the cell into its densest H3 neighbor so the stats don't fragment. Tuned
// empirically: with ~4700 listings in Núñez, threshold 300 leaves 4-6
// "zones" (each ~700-900 listings), in line with the user's mental model
// of "3-5 zonas por barrio grande" (Núñez Norte, Bajo Belgrano, etc.).
const MIN_LISTINGS = 300;
// Cap on auto-merge iterations. Empirically 2-3 passes converge; the cap
// guards against any pathological case (shouldn't happen in practice).
const MAX_MERGE_ITERATIONS = 10;
// Soft cap on label length so the UI doesn't blow up on weird inputs.
const MAX_LABEL = 80;

// Optional manual overrides: `data/subzone-overrides.json` maps H3 cell id
// to a custom label ("Bajo Belgrano", etc). Loaded lazily and cached.
let overridesCache = null;
function getOverrides() {
  if (overridesCache !== null) return overridesCache;
  const file = path.join(config.dataDir, 'subzone-overrides.json');
  if (!existsSync(file)) {
    overridesCache = {};
    return overridesCache;
  }
  try {
    overridesCache = JSON.parse(readFileSync(file, 'utf-8')) || {};
  } catch (err) {
    logger.warn({ err: err.message, file }, 'subzone-overrides.json invalid; ignoring');
    overridesCache = {};
  }
  return overridesCache;
}

// Avenue corridors: listings whose address matches any of the configured
// patterns get pinned to a fixed sub_zone id (e.g. "av-libertador-nunez")
// instead of the H3 cell they fall into. Used for premium avenues where the
// price profile differs sharply from the rest of the barrio. See
// data/avenue-corridors.json for the per-neighborhood patterns.
let corridorsCache = null;
function getCorridors() {
  if (corridorsCache !== null) return corridorsCache;
  const file = path.join(config.dataDir, 'avenue-corridors.json');
  if (!existsSync(file)) {
    corridorsCache = {};
    return corridorsCache;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) || {};
    // Drop the "_comment" key so we don't iterate over it as a neighborhood.
    corridorsCache = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      corridorsCache[k] = Array.isArray(v) ? v : [];
    }
  } catch (err) {
    logger.warn({ err: err.message, file }, 'avenue-corridors.json invalid; ignoring');
    corridorsCache = {};
  }
  return corridorsCache;
}

// Cell ids for avenue corridors start with this prefix — used by the merge
// step to skip them (they have no H3 neighbors).
function isCorridorId(cellId) {
  return typeof cellId === 'string' && cellId.startsWith('av-');
}

// Address normalization for substring matching: strip accents, lowercase,
// collapse whitespace. Mirrors street-fuzzy's normalize but inlined here so
// this module is self-contained.
function normalizeAddr(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Apply avenue-corridor overrides for one neighborhood. For every active
// listing in that barrio whose address matches a corridor pattern, set
// `sub_zone` to the corridor's fixed id. Idempotent: a listing already
// pinned to a corridor id gets re-checked and assigned again (safe).
// Returns the count of pinned listings.
function applyAvenueCorridors(neighborhood) {
  const corridors = getCorridors()[neighborhood] || [];
  if (corridors.length === 0) return 0;
  const db = getDb();
  const listings = db
    .prepare(`SELECT id, address FROM listings
              WHERE active=1 AND neighborhood=? AND address IS NOT NULL`)
    .all(neighborhood);
  const upd = db.prepare('UPDATE listings SET sub_zone=? WHERE id=?');
  // Pre-normalize all corridor patterns once.
  const compiled = corridors.map((c) => ({
    id: c.id,
    label: c.label,
    patterns: (c.match || []).map(normalizeAddr).filter(Boolean),
  }));
  let pinned = 0;
  const tx = db.transaction(() => {
    for (const l of listings) {
      const addr = normalizeAddr(l.address);
      if (!addr) continue;
      for (const c of compiled) {
        if (c.patterns.some((p) => addr.includes(p))) {
          upd.run(c.id, l.id);
          pinned++;
          break;
        }
      }
    }
  });
  tx();
  return pinned;
}

// Pull the street name out of a free-form address. Most AR-style addresses
// are "<Street> <Number>, <Barrio>, <City>" — we strip leading "Av./Avenida/
// Calle" prefixes, take everything up to the first digit run, and clean up
// trailing connectors like "al" ("Av. Cabildo al 4600" → "Av. Cabildo").
export function extractStreet(address) {
  if (!address) return null;
  const cleaned = String(address).replace(/\s+/g, ' ').trim();
  const m = cleaned.match(/^([A-ZÁÉÍÓÚÑa-záéíóúñ.][^,\d]{1,60}?)\s+(?:al\s+)?\d/);
  if (!m) return null;
  let street = m[1].trim();
  // Strip common noise prefixes that don't help disambiguate the street.
  street = street.replace(/^(calle|av\.?|avenida)\s+/i, '');
  // Normalize whitespace + remove trailing punctuation.
  street = street.replace(/[.,;]+$/, '').trim();
  if (!street || street.length < 2) return null;
  return street;
}

// Build a human-readable label from the top-2 most-mentioned streets in the
// cell. Falls back to the single street if only one is present, or to the
// raw H3 cell id if the cell has no parseable addresses (defensive — should
// not happen since cells only exist when listings inside them have addresses).
export function deriveLabel(cellId, streetCounts) {
  const overrides = getOverrides();
  if (overrides[cellId]) return overrides[cellId];
  const sorted = Object.entries(streetCounts)
    .filter(([s]) => s)
    .sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return cellId;
  if (sorted.length === 1) return sorted[0][0].slice(0, MAX_LABEL);
  // Top 2. Tie-breaker is alphabetical (stable across runs).
  const a = sorted[0][0];
  const b = sorted[1][0];
  return `${a} & ${b}`.slice(0, MAX_LABEL);
}

// Auto-merge: any cell with <MIN_LISTINGS listings gets absorbed into its
// densest H3-neighbor that exists in the same neighborhood. The merge:
//   1. Iterates until no further changes — a chain of sparse cells needs
//      multiple passes to consolidate cleanly.
//   2. First tries ring-1 neighbors (6 hexes). If none of them has any
//      listings, falls back to ring-2 (18 hexes) so cells near the barrio's
//      edge aren't stuck without a target.
//   3. If after iteration a sparse cell still has no neighbor at all (very
//      isolated), absorbs it into the largest cell of the same neighborhood
//      as a last-resort, so we never leave 1-2 listing micro-cells dangling.
// All merges happen in a single transaction to avoid intermediate state.
function autoMergeSparseCells(neighborhood) {
  const db = getDb();
  const cells = db
    .prepare(`
      SELECT sub_zone, COUNT(*) AS cnt FROM listings
      WHERE active=1 AND neighborhood=? AND sub_zone IS NOT NULL
      GROUP BY sub_zone
    `)
    .all(neighborhood);
  const byId = new Map(cells.map((c) => [c.sub_zone, c.cnt]));
  let mergedCount = 0;

  function findBestNeighbor(cellId, ring) {
    const neighbors = neighborCells(cellId, ring);
    let bestId = null;
    let bestCnt = 0;
    for (const nb of neighbors) {
      const c = byId.get(nb);
      if (c != null && c > bestCnt) {
        bestCnt = c;
        bestId = nb;
      }
    }
    return bestId;
  }

  function largestCell() {
    let bestId = null;
    let bestCnt = 0;
    for (const [id, cnt] of byId) {
      if (cnt > bestCnt) { bestCnt = cnt; bestId = id; }
    }
    return bestId;
  }

  const tx = db.transaction(() => {
    const stmt = db.prepare('UPDATE listings SET sub_zone=? WHERE sub_zone=? AND neighborhood=?');
    // Iterate ring-1 / ring-2 merges to convergence.
    let changed = true;
    let iters = 0;
    while (changed && iters < MAX_MERGE_ITERATIONS) {
      changed = false;
      iters++;
      for (const [cellId, cnt] of byId) {
        if (cnt === 0 || cnt >= MIN_LISTINGS) continue;
        // Avenue corridors are NEVER merged — they're a manually-chosen
        // segment whose price profile differs from the rest of the barrio.
        // A 10-listing corridor stays as its own zone (the rent-match cascade
        // falls back to neighborhood when it has too few comparables).
        if (isCorridorId(cellId)) continue;
        let target = findBestNeighbor(cellId, 1);
        if (target == null) target = findBestNeighbor(cellId, 2);
        if (target == null) continue; // still orphan — handled below
        stmt.run(target, cellId, neighborhood);
        byId.set(target, (byId.get(target) || 0) + cnt);
        byId.set(cellId, 0);
        mergedCount++;
        changed = true;
      }
    }
    // Last resort: orphan cells with no dense neighbor anywhere within ring 2
    // get absorbed into the largest cell of the barrio. Keeps cardinality low.
    for (const [cellId, cnt] of byId) {
      if (cnt === 0 || cnt >= MIN_LISTINGS) continue;
      if (isCorridorId(cellId)) continue; // never absorb corridor zones
      const target = largestCell();
      if (target == null || target === cellId) continue;
      stmt.run(target, cellId, neighborhood);
      byId.set(target, (byId.get(target) || 0) + cnt);
      byId.set(cellId, 0);
      mergedCount++;
    }
  });
  tx();
  return mergedCount;
}

// Recompute labels for every sub-zone in a neighborhood. Idempotent — call
// after geocoding/merging in the orchestrator. Order matters:
//   1. Pin listings on configured avenues to corridor sub-zones (e.g.
//      "av-libertador-nunez") before the merge sees them — that way corridors
//      don't get cannibalized by neighboring H3 cells.
//   2. Auto-merge sparse H3 cells (corridors are skipped).
//   3. Recompute labels: corridors use their configured label; everything
//      else uses the top-2 streets heuristic.
export function recomputeLabelsForNeighborhood(neighborhood) {
  const db = getDb();
  const pinned = applyAvenueCorridors(neighborhood);
  const merged = autoMergeSparseCells(neighborhood);
  // Map of corridor-id → configured label for the lookup below.
  const corridorLabels = new Map(
    (getCorridors()[neighborhood] || []).map((c) => [c.id, c.label]),
  );
  const rows = db
    .prepare(`
      SELECT sub_zone, address FROM listings
      WHERE active=1 AND neighborhood=? AND sub_zone IS NOT NULL AND address IS NOT NULL
    `)
    .all(neighborhood);
  const perCell = new Map();
  for (const r of rows) {
    const street = extractStreet(r.address);
    if (!street) continue;
    let bag = perCell.get(r.sub_zone);
    if (!bag) {
      bag = { count: 0, streets: {} };
      perCell.set(r.sub_zone, bag);
    }
    bag.count++;
    bag.streets[street] = (bag.streets[street] || 0) + 1;
  }
  const upsert = db.prepare(`
    INSERT INTO sub_zone_labels (sub_zone, neighborhood, label, listing_count, computed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sub_zone, neighborhood) DO UPDATE SET
      label=excluded.label,
      listing_count=excluded.listing_count,
      computed_at=excluded.computed_at
  `);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const [cellId, bag] of perCell) {
      // Corridor cells use their fixed config label; everything else gets
      // the auto-derived top-streets label.
      const label = corridorLabels.get(cellId) || deriveLabel(cellId, bag.streets);
      upsert.run(cellId, neighborhood, label, bag.count, now);
    }
  });
  tx();
  logger.info(
    { neighborhood, cells: perCell.size, merged, corridors_pinned: pinned },
    'subzone labels recomputed',
  );
  return { cells: perCell.size, merged, pinned };
}
