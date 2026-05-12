import { Router } from 'express';
import { getMepRate } from '../fx.js';

export const fxRoute = Router();

fxRoute.get('/', async (_req, res) => {
  try {
    const rate = await getMepRate();
    res.json({
      type: rate.type,
      buy: rate.buy,
      sell: rate.sell,
      fetched_at: rate.fetchedAt,
      // Back-compat aliases (old UI clients still read these).
      mep_buy: rate.buy,
      mep_sell: rate.sell,
    });
  } catch (err) {
    res.status(503).json({ error: 'fx_unavailable', message: err.message });
  }
});
