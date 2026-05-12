import { logger } from '../logger.js';

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
};

// More specific patterns: avoid matching the strings "cloudflare"/"captcha" when they appear
// inside script URLs or assets on legitimately served pages. We only treat a response as blocked
// when these appear in challenge titles or as standalone error markers.
const BLOCK_PATTERNS = [
  /<title>[^<]*(access denied|attention required|just a moment|verifying you are human)/i,
  /datadome-(?:captcha|challenge|js)/i,
  /<h1[^>]*>\s*(access denied|forbidden)\s*<\/h1>/i,
  /\bcf-chl-(?:bypass|widget)\b/i,
  /window\.DataDome/,
];

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function jitter(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

export class BlockedError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BlockedError';
    this.status = status;
  }
}

// 404 / 410 means the listing was removed by the publisher. We tag these
// so callers can deactivate the row in DB instead of looping retries.
export class ListingGoneError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ListingGoneError';
    this.status = status;
  }
}

export async function fetchJson(url, { headers = {}, retries = 3, timeoutMs = 15_000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { ...DEFAULT_HEADERS, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        throw new BlockedError(`http ${res.status}`, res.status);
      }
      if (res.status === 404 || res.status === 410) {
        throw new ListingGoneError(`http ${res.status}`, res.status);
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const text = await res.text();
      if (BLOCK_PATTERNS.some((re) => re.test(text))) {
        throw new BlockedError('anti-bot challenge detected in body', res.status);
      }
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      if (err instanceof BlockedError && attempt === retries - 1) throw err;
      const wait = jitter(500, 2000) * (attempt + 1);
      logger.debug({ url, attempt, err: err.message, wait }, 'fetchJson retry');
      await sleep(wait);
    }
  }
  throw lastErr;
}

export async function fetchText(url, { headers = {}, retries = 3, timeoutMs = 15_000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { ...DEFAULT_HEADERS, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        throw new BlockedError(`http ${res.status}`, res.status);
      }
      if (res.status === 404 || res.status === 410) {
        throw new ListingGoneError(`http ${res.status}`, res.status);
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      const text = await res.text();
      if (BLOCK_PATTERNS.some((re) => re.test(text))) {
        throw new BlockedError('anti-bot challenge detected in body', res.status);
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (err instanceof BlockedError && attempt === retries - 1) throw err;
      const wait = jitter(500, 2000) * (attempt + 1);
      logger.debug({ url, attempt, err: err.message, wait }, 'fetchText retry');
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Locale-aware number parsing. Handles:
//   "USD 133.000"  → 133000  (dot is thousand separator)
//   "41,50 m²"     → 41.5    (comma is decimal)
//   "2.500,75"     → 2500.75 (es-AR convention)
//   "1,234.56"     → 1234.56 (en-US convention)
//   "39"           → 39
export function safeNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^\d.,\-]/g, '');
  if (s === '' || s === '-') return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // Whichever appears LAST is the decimal separator.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma && !hasDot) {
    // Comma is decimal in es-AR locale.
    s = s.replace(',', '.');
  } else if (hasDot && !hasComma) {
    // Heuristic: groups of exactly 3 digits separated by dots → thousand separator.
    // Otherwise the dot is a decimal point.
    const parts = s.split('.');
    if (parts.length > 1 && parts.slice(1).every((p) => p.length === 3) && parts[0].length > 0) {
      s = s.replace(/\./g, '');
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
