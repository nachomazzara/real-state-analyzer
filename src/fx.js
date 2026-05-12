import { getDb } from './db.js';
import { logger } from './logger.js';
import { config } from './config.js';

// dolarapi.com exposes one endpoint per dollar type. The slug matches their
// "casa" identifier. Configurable via FX_RATE_TYPE env var; defaults to oficial.
const VALID_TYPES = new Set([
  'oficial',
  'blue',
  'bolsa', // MEP
  'contadoconliqui', // CCL
  'mayorista',
  'cripto',
  'tarjeta',
]);
const TTL_MS = 60 * 60 * 1000; // 1h

let memCache = null;

function rateType() {
  const t = (config.fxRateType || 'oficial').toLowerCase();
  return VALID_TYPES.has(t) ? t : 'oficial';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Function kept named getMepRate() for back-compat with importers, but it now
// returns whichever USD rate FX_RATE_TYPE specifies.
export async function getMepRate() {
  const type = rateType();
  if (memCache && memCache.type === type && Date.now() - memCache.fetchedAt < TTL_MS) {
    return memCache.rate;
  }
  const db = getDb();
  const cacheKey = `${todayISO()}:${type}`;
  const row = db
    .prepare('SELECT mep_buy, mep_sell, fetched_at FROM fx_rates WHERE date = ?')
    .get(cacheKey);
  if (row && Date.now() - row.fetched_at < TTL_MS) {
    memCache = {
      type,
      rate: { type, buy: row.mep_buy, sell: row.mep_sell, fetchedAt: row.fetched_at },
      fetchedAt: row.fetched_at,
    };
    return memCache.rate;
  }

  try {
    const res = await fetch(`https://dolarapi.com/v1/dolares/${type}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'real-state-analyzer/0.1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FX API ${res.status}`);
    const data = await res.json();
    const buy = Number(data.compra);
    const sell = Number(data.venta);
    if (!Number.isFinite(buy) || !Number.isFinite(sell)) {
      throw new Error('FX API returned non-numeric values');
    }
    const now = Date.now();
    db.prepare(
      `INSERT INTO fx_rates (date, mep_buy, mep_sell, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET mep_buy = excluded.mep_buy, mep_sell = excluded.mep_sell, fetched_at = excluded.fetched_at`,
    ).run(cacheKey, buy, sell, now);
    memCache = { type, rate: { type, buy, sell, fetchedAt: now }, fetchedAt: now };
    logger.info({ type, buy, sell }, 'fx rate refreshed');
    return memCache.rate;
  } catch (err) {
    logger.warn({ type, err: err.message }, 'failed to refresh fx rate, falling back');
    if (row) {
      return { type, buy: row.mep_buy, sell: row.mep_sell, fetchedAt: row.fetched_at };
    }
    throw err;
  }
}

export function arsToUsd(amount, rate) {
  if (!Number.isFinite(amount) || !rate) return null;
  // Use sell side (the higher one) so the USD value is conservative.
  return amount / rate.sell;
}

export function toUsd(amount, currency, rate) {
  if (!Number.isFinite(amount)) return null;
  if (currency === 'USD') return amount;
  if (currency === 'ARS') return arsToUsd(amount, rate);
  return null;
}
