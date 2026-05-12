import { Router } from 'express';
import { readFileSync } from 'node:fs';
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

neighborhoodsRoute.get('/', (_req, res) => {
  try {
    const data = load();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'neighborhoods_load_failed', message: err.message });
  }
});
