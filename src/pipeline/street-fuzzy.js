import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Fuzzy street-name corrector for CABA. When USIG can't resolve an address
// because the street is misspelled ("Daheza" instead of "Deheza"), we look
// up the closest match in the official CABA callejero (downloaded once via
// scripts/build-caba-streets.js) and return the corrected name so the
// caller can retry the geocode.

let catalog = null; // { keys: string[], displays: string[] }

function loadCatalog() {
  if (catalog) return catalog;
  const file = path.join(config.dataDir, 'caba-streets.json');
  if (!existsSync(file)) {
    logger.warn({ file }, '[FUZZY] caba-streets.json missing — fuzzy correction disabled. Run: node scripts/build-caba-streets.js');
    catalog = { keys: [], displays: [] };
    return catalog;
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    catalog = {
      keys: data.streets.map((s) => s.key),
      displays: data.streets.map((s) => s.display),
    };
    logger.info({ count: catalog.keys.length }, '[FUZZY] CABA street catalog loaded');
  } catch (err) {
    logger.warn({ err: err.message }, '[FUZZY] failed to load catalog');
    catalog = { keys: [], displays: [] };
  }
  return catalog;
}

function normalize(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Damerau-Levenshtein distance with early termination. Returns Infinity when
// the distance can't possibly be ≤ maxDist (so we skip most candidates fast).
function damerauLevenshtein(a, b, maxDist) {
  if (Math.abs(a.length - b.length) > maxDist) return Infinity;
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  // 3-row rolling matrix (current + previous two for transposition).
  let prev2 = new Array(n + 1);
  let prev1 = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev1[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        curr[j - 1] + 1,    // insertion
        prev1[j] + 1,        // deletion
        prev1[j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1); // transposition
      }
      curr[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > maxDist) return Infinity; // pruning
    const tmp = prev2; prev2 = prev1; prev1 = curr; curr = tmp;
  }
  return prev1[n];
}

// Find the closest street name in CABA to `streetText`. Returns the
// catalog's display form when the best distance is ≤ MAX_DIST, else null.
// Skips trivial misses quickly.
const MAX_DIST = 3;
export function findClosestStreet(streetText) {
  const target = normalize(streetText);
  if (!target || target.length < 3) return null;
  const { keys, displays } = loadCatalog();
  if (keys.length === 0) return null;
  // Quick path: exact prefix match (handles "Cabildo" matching "Cabildo Av.").
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === target) return { display: displays[i], distance: 0 };
  }
  let bestIdx = -1;
  let bestDist = MAX_DIST + 1;
  for (let i = 0; i < keys.length; i++) {
    const d = damerauLevenshtein(target, keys[i], bestDist - 1);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
      if (d === 0) break;
    }
  }
  if (bestIdx < 0 || bestDist > MAX_DIST) return null;
  return { display: displays[bestIdx], distance: bestDist };
}

// Split an address like "Daheza 2350" into { street: "Daheza", altura: 2350 }.
// Returns null if no street/altura pair found.
export function splitStreetAndAltura(address) {
  const m = String(address || '').match(/^(.+?)\s+(\d{2,5})\s*$/);
  if (!m) return null;
  return { street: m[1].trim(), altura: Number(m[2]) };
}

// Find the longest catalog street name that appears as a SUBSTRING of the
// input text. Used as a last-resort recovery when the address has a known
// street embedded in garbage ("CiudCiudad de la Paz ad de la Paz" contains
// "ciudad de la paz"). Prefers the longest match so multi-word names beat
// short shared tokens. Returns null if no catalog key ≥ 5 chars matches.
export function findStreetSubstring(text) {
  const haystack = normalize(text);
  if (!haystack || haystack.length < 5) return null;
  const { keys, displays } = loadCatalog();
  if (keys.length === 0) return null;
  let bestIdx = -1;
  let bestLen = 4; // require ≥ 5 chars to avoid matching "av" / "y" / etc.
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.length <= bestLen) continue;
    if (haystack.includes(k)) { bestLen = k.length; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  return { display: displays[bestIdx], match: keys[bestIdx] };
}
