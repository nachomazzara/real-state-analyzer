// One-shot: download CABA's official callejero CSV from datos abiertos
// (data.buenosaires.gob.ar) and save a deduped + normalized list of street
// names to data/caba-streets.json. This file feeds the fuzzy-match path in
// geocode.js — when USIG can't resolve an address because of a typo, we
// look up the closest CABA street and retry with the corrected name.
//
// Run via: node scripts/build-caba-streets.js
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const CALLEJERO_URL = 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/jefatura-de-gabinete-de-ministros/calles/callejero.csv';
const OUT = path.join('data', 'caba-streets.json');

// Strip diacritics + lowercase for the search key. Keeps a separate display
// version so we can show the user the corrected match.
function normalize(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

(async () => {
  console.log('downloading callejero CSV...');
  const res = await fetch(CALLEJERO_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    console.error('download failed:', res.status);
    process.exit(1);
  }
  const csv = await res.text();
  console.log(`got ${csv.length} bytes`);

  // Minimal CSV parse — the file has quoted fields with commas inside.
  const lines = csv.split(/\r?\n/);
  const header = parseRow(lines[0]);
  const colMap = {};
  header.forEach((h, i) => { colMap[h.trim().toLowerCase()] = i; });
  const nameCol = colMap['nomoficial'] ?? colMap['nom_oficial'] ?? colMap['nombre_oficial'];
  const mapCol = colMap['nom_mapa'];

  const names = new Map(); // normalized → preferred display
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = parseRow(lines[i]);
    const candidates = [
      row[nameCol],
      row[mapCol],
    ].filter(Boolean);
    for (const raw of candidates) {
      const display = raw.replace(/[",]+$/g, '').trim();
      if (!display) continue;
      // Strip type-suffixes like ", AV." / ", INT." / ", GRAL.AV.": we want
      // just the core street name for matching.
      const cleaned = display
        // Strip all leading/inline/trailing "AV." or "AVDA." occurrences so
        // "AV. CABILDO" / "CABILDO AV." / "AVDA. DEL LIBERTADOR" all
        // normalize to just the core street name.
        .replace(/\bAV\.?\s*/gi, '')
        .replace(/\bAVDA\.?\s*/gi, '')
        // Strip leading type words
        .replace(/^(CALLE|PASAJE|PJE\.?|DIAG\.?)\s+/i, '')
        // Strip trailing type/title suffixes after comma
        .replace(/,\s*(GRAL\.?|TTE\.?|INT\.?|CAP\.?|CTE\.?|DR\.?|SR\.?|SRA\.?|PJE\.?|DIAG\.?|MTRO\.?)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length < 2) continue;
      // Generate multiple keys so fuzzy can match partial street names:
      //   - the cleaned full form
      //   - "first surname only" for comma names ("LUGONES, LEOPOLDO" → "lugones")
      //   - each significant single word (>=4 chars) — so "rooselvet"
      //     can fuzzy-match the lone "roosevelt" token from "FRANKLIN D.
      //     ROOSEVELT", which threshold-3 distance would never reach
      //     against the full name.
      const variants = [cleaned];
      if (cleaned.includes(',')) {
        const surnameOnly = cleaned.split(',')[0].trim();
        if (surnameOnly.length >= 2) variants.push(surnameOnly);
      }
      // Skip common Spanish connectors when extracting single-word tokens
      const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'da', 'do']);
      for (const word of cleaned.split(/[\s,.]+/)) {
        const w = word.trim();
        if (w.length >= 4 && !STOPWORDS.has(w.toLowerCase()) && !/^\d/.test(w)) {
          variants.push(w);
        }
      }
      for (const v of variants) {
        const key = normalize(v);
        // Single-word tokens are added with the FULL street as display
        // (so the matcher gets "FRANKLIN D. ROOSEVELT" not just "ROOSEVELT").
        if (!names.has(key)) names.set(key, cleaned);
      }
    }
  }
  console.log(`extracted ${names.size} unique streets`);

  mkdirSync('data', { recursive: true });
  const out = {
    builtAt: new Date().toISOString(),
    source: CALLEJERO_URL,
    streets: Array.from(names.entries()).map(([key, display]) => ({ key, display })),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT}`);

  // Sanity-check: known streets must be present.
  const sanity = ['deheza', "o'higgins", 'cabildo', 'libertador', 'crisologo larralde'];
  for (const s of sanity) {
    console.log(`  ${s}: ${names.has(s) ? 'YES' : 'MISS'}`);
  }
})();

function parseRow(line) {
  // Handles quoted fields with embedded commas. Not a full RFC parser but
  // enough for the callejero CSV format.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
