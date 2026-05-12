import { Router } from 'express';
import { rankProperties } from '../pipeline/yield-rank.js';
import { getAnalysis } from '../analyses.js';

export const propertiesRoute = Router();

function boolParam(v, d = false) {
  if (v == null) return d;
  return v === 'true' || v === '1' || v === true;
}
function numParam(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

propertiesRoute.get('/', (req, res) => {
  let neighborhoods = null;
  let filters = {};

  if (req.query.analysis_id) {
    const a = getAnalysis(String(req.query.analysis_id));
    if (!a) return res.status(404).json({ error: 'analysis_not_found' });
    neighborhoods = a.neighborhoods;
    filters = a.filters;
  } else {
    const raw = String(req.query.neighborhoods || '').trim();
    if (!raw) return res.status(400).json({ error: 'neighborhoods_required' });
    neighborhoods = raw.split(',').map((s) => s.trim()).filter(Boolean);
    filters = {
      include_pozo: boolParam(req.query.include_pozo),
      include_construccion: boolParam(req.query.include_construccion),
      require_pool: boolParam(req.query.require_pool),
      require_garage: boolParam(req.query.require_garage),
      min_rooms: req.query.min_rooms ? numParam(req.query.min_rooms, null) : null,
      max_rooms: req.query.max_rooms ? numParam(req.query.max_rooms, null) : null,
      min_yield: numParam(req.query.min_yield, 0.05),
      min_build_yield: numParam(req.query.min_build_yield, 0.05),
    };
  }
  if (!neighborhoods?.length) return res.status(400).json({ error: 'neighborhoods_required' });

  const items = rankProperties({
    neighborhoods,
    includePozo: !!filters.include_pozo,
    includeConstruccion: !!filters.include_construccion,
    minYield: filters.min_yield ?? 0.05,
    minBuildYield: filters.min_build_yield ?? 0.05,
    minRooms: filters.min_rooms ?? null,
    maxRooms: filters.max_rooms ?? null,
    requirePool: !!filters.require_pool,
    requireGarage: !!filters.require_garage,
    sort: String(req.query.sort || 'score'),
  });
  res.json({ count: items.length, items, filters });
});
