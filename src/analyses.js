import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Canonical, ordered representation of an analysis's identity. Same combo of
// neighborhoods + filters yields the same signature, regardless of input
// order, so we can dedupe across submissions.
const FILTER_KEYS = [
  'include_pozo',
  'include_construccion',
  'require_pool',
  'require_garage',
  'min_rooms',
  'max_rooms',
  'min_yield',
  'min_build_yield',
];

export function canonicalize(neighborhoods, filters = {}) {
  const nbs = [...new Set((neighborhoods || []).map((n) => String(n).trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
  const f = {};
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (v == null || v === '' || v === false) continue;
    // Numbers: only include positive finite values; coerce strings.
    if (k.startsWith('min_') || k.startsWith('max_')) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      f[k] = n;
    } else {
      f[k] = v === true || v === 'true' || v === 1 || v === '1';
    }
  }
  return { neighborhoods: nbs, filters: f };
}

export function signatureOf(canonical) {
  const h = createHash('sha1');
  h.update(JSON.stringify(canonical));
  return h.digest('hex').slice(0, 16);
}

export function labelOf(canonical) {
  const nbs = canonical.neighborhoods.join(' · ');
  const pieces = [];
  const f = canonical.filters;
  if (f.min_rooms || f.max_rooms) {
    pieces.push(`${f.min_rooms ?? '?'}-${f.max_rooms ?? '?'} amb`);
  }
  if (f.require_pool) pieces.push('🏊');
  if (f.require_garage) pieces.push('🚗');
  if (f.include_pozo) pieces.push('+ pozo');
  if (f.include_construccion) pieces.push('+ obra');
  if (f.min_yield) pieces.push(`yield≥${(f.min_yield * 100).toFixed(1)}%`);
  if (f.min_build_yield) pieces.push(`buildyield≥${(f.min_build_yield * 100).toFixed(1)}%`);
  return nbs + (pieces.length ? ' · ' + pieces.join(' · ') : '');
}

export function getAnalysis(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

export function getAnalysisBySignature(signature) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM analyses WHERE signature = ?').get(signature);
  return row ? hydrate(row) : null;
}

export function upsertAnalysis({ neighborhoods, filters }) {
  const db = getDb();
  const canonical = canonicalize(neighborhoods, filters);
  if (!canonical.neighborhoods.length) {
    throw new Error('at least one neighborhood is required');
  }
  const signature = signatureOf(canonical);
  const existing = getAnalysisBySignature(signature);
  const now = Date.now();
  if (existing) {
    db.prepare(
      `UPDATE analyses SET last_viewed_at = ?, view_count = view_count + 1 WHERE id = ?`,
    ).run(now, existing.id);
    return getAnalysis(existing.id);
  }
  const id = randomUUID();
  const label = labelOf(canonical);
  db.prepare(
    `INSERT INTO analyses (id, signature, neighborhoods_json, filters_json, label, created_at, last_viewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    signature,
    JSON.stringify(canonical.neighborhoods),
    JSON.stringify(canonical.filters),
    label,
    now,
    now,
  );
  return getAnalysis(id);
}

export function touchAnalysis(id) {
  const db = getDb();
  db.prepare(
    `UPDATE analyses SET last_viewed_at = ?, view_count = view_count + 1 WHERE id = ?`,
  ).run(Date.now(), id);
}

export function setLastScrapeJob(id, jobId) {
  getDb().prepare('UPDATE analyses SET last_scrape_job_id = ? WHERE id = ?').run(jobId, id);
}

export function listAnalyses(limit = 20) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM analyses ORDER BY last_viewed_at DESC LIMIT ?')
    .all(limit);
  return rows.map(hydrate);
}

function hydrate(row) {
  return {
    id: row.id,
    signature: row.signature,
    neighborhoods: JSON.parse(row.neighborhoods_json),
    filters: JSON.parse(row.filters_json),
    label: row.label,
    created_at: row.created_at,
    last_viewed_at: row.last_viewed_at,
    last_scrape_job_id: row.last_scrape_job_id,
    view_count: row.view_count,
  };
}
