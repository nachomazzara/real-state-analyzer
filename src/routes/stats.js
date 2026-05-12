import { Router } from 'express';
import { computeStatsForNeighborhood, computeAggregate, getCellListings } from '../pipeline/stats.js';
import { getAnalysis } from '../analyses.js';

export const statsRoute = Router();

function boolParam(v, d = false) {
  if (v == null) return d;
  return v === 'true' || v === '1' || v === true;
}
function numParam(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

statsRoute.get('/', (req, res) => {
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
      min_rooms: numParam(req.query.min_rooms),
      max_rooms: numParam(req.query.max_rooms),
    };
  }
  if (!neighborhoods?.length) return res.status(400).json({ error: 'neighborhoods_required' });

  const perNeighborhood = neighborhoods.map((n) => computeStatsForNeighborhood(n, filters));
  const aggregate = neighborhoods.length > 1 ? computeAggregate(neighborhoods, filters) : null;
  res.json({ per_neighborhood: perNeighborhood, aggregate, filters });
});

// Inspector for a single matrix cell: returns the listings that went INTO the
// median (kept) and the ones excluded as premium tier, both sorted. Lets the
// user audit "why is the median that number" by hand.
statsRoute.get('/cell-listings', (req, res) => {
  const neighborhood = String(req.query.neighborhood || '').trim();
  const matrix = String(req.query.matrix || 'venta').trim(); // 'venta' | 'alquiler'
  const age = String(req.query.age || '').trim();
  const rooms = String(req.query.rooms || '').trim();
  if (!neighborhood || !age || !rooms) {
    return res.status(400).json({ error: 'neighborhood, age and rooms required' });
  }
  let filters = {};
  if (req.query.analysis_id) {
    const a = getAnalysis(String(req.query.analysis_id));
    if (!a) return res.status(404).json({ error: 'analysis_not_found' });
    filters = a.filters;
  } else {
    filters = {
      include_pozo: boolParam(req.query.include_pozo),
      include_construccion: boolParam(req.query.include_construccion),
      require_pool: boolParam(req.query.require_pool),
      require_garage: boolParam(req.query.require_garage),
      min_rooms: numParam(req.query.min_rooms),
      max_rooms: numParam(req.query.max_rooms),
    };
  }
  res.json(getCellListings({ neighborhood, matrix, age, rooms, filters }));
});
