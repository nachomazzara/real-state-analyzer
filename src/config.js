import path from 'node:path';
import { fileURLToPath } from 'node:url';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// Resolve data dir: env wins (Docker sets DATA_DIR=/app/data), otherwise
// fall back to a `./data` folder next to the package root so `node src/server.js`
// from a clone works out of the box.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(REPO_ROOT, 'data');

export const config = {
  port: num(process.env.PORT, 3000),
  cacheTtlHours: num(process.env.CACHE_TTL_HOURS, 24),
  maxConcurrency: num(process.env.MAX_CONCURRENCY, 2),
  logLevel: process.env.LOG_LEVEL || 'info',
  incrementalStopAfter: num(process.env.INCREMENTAL_STOP_AFTER, 30),
  fullRefreshDays: num(process.env.FULL_REFRESH_DAYS, 7),
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'analyzer.db'),
  rentFallbackPath: path.join(DATA_DIR, 'rent-fallback.json'),
  neighborhoodsPath: path.join(DATA_DIR, 'neighborhoods.json'),
  defaultMinYield: 0.05,
  defaultMinBuildYield: 0.05,
  minStatsSamples: 3,
  // Which dolarapi.com USD quote to use to convert ARS prices/rents to USD.
  // Valid values: oficial, blue, bolsa, contadoconliqui, mayorista, cripto, tarjeta.
  // Default 'oficial' per user preference; change in .env to swap.
  fxRateType: (process.env.FX_RATE_TYPE || 'oficial').toLowerCase(),
};
