import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const neighborhoodsRoute = Router();

let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;

function load() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  const raw = readFileSync(config.neighborhoodsPath, 'utf8');
  cached = JSON.parse(raw);
  cachedAt = Date.now();
  return cached;
}

// CABA barrios polygons — populated by scripts/build-caba-barrios.js into
// data/caba-barrios.json. Map shape: { id → { display, geometry } } where
// geometry is GeoJSON (MultiPolygon/Polygon). Cached after first load.
let cachedBarrios = null;
function loadBarrios() {
  if (cachedBarrios !== null) return cachedBarrios;
  const file = path.join(config.dataDir, 'caba-barrios.json');
  if (!existsSync(file)) {
    cachedBarrios = {};
    return cachedBarrios;
  }
  try {
    cachedBarrios = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    cachedBarrios = {};
  }
  return cachedBarrios;
}

neighborhoodsRoute.get('/', (_req, res) => {
  try {
    const data = load();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'neighborhoods_load_failed', message: err.message });
  }
});

// Returns the GeoJSON polygon for a single barrio, e.g. /api/neighborhoods/nunez/boundary.
// GBA Norte neighborhoods (Vicente López, San Isidro, etc) aren't in the
// CABA dataset and return 404 — the frontend should fall back to "no
// polygon, just markers" for those.
neighborhoodsRoute.get('/:id/boundary', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id_required' });
  const all = loadBarrios();
  const hit = all[id];
  if (!hit) return res.status(404).json({ error: 'boundary_not_found', id });
  res.json({ id, display: hit.display, geometry: hit.geometry });
});
