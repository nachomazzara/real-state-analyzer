// One-shot: download CABA's official "barrios" GeoJSON from datos abiertos
// (data.buenosaires.gob.ar) and save a slimmed copy to data/caba-barrios.json
// keyed by neighborhood id. The frontend uses these polygons to draw the
// barrio outline on the map view.
//
// We slug each official BARRIO name to match our neighborhoods.json `id`
// field (kebab-case, ASCII, no accents) so the API can look them up by id.
//
// Run via: node scripts/build-caba-barrios.js
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BARRIOS_URL =
  'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/ministerio-de-educacion/barrios/barrios.geojson';

const OUT = path.join('data', 'caba-barrios.json');

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

(async () => {
  console.log('downloading barrios GeoJSON…');
  const res = await fetch(BARRIOS_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    console.error('download failed:', res.status);
    process.exit(1);
  }
  const geojson = await res.json();
  if (!geojson || geojson.type !== 'FeatureCollection') {
    console.error('unexpected payload shape; missing FeatureCollection');
    process.exit(1);
  }
  console.log(`got ${geojson.features.length} features`);

  // Load our neighborhoods.json so we can warn about any mismatch — e.g. if
  // the official dataset uses "Núñez" but our id is "nunez", we want both
  // sides to match after slugifying.
  let configIds = new Set();
  try {
    const cfg = JSON.parse(readFileSync(path.join('data', 'neighborhoods.json'), 'utf-8'));
    configIds = new Set((cfg.neighborhoods || []).map((n) => n.id));
  } catch {
    console.warn('warning: could not load data/neighborhoods.json — skipping id-match check');
  }

  // Known differences between the GCBA dataset's barrio name and our
  // neighborhoods.json id. "PATERNAL" vs "LA PATERNAL", "VILLA GRAL. MITRE"
  // vs "VILLA GENERAL MITRE", etc. Map GCBA-slug → our-id so the lookup is
  // consistent.
  const aliases = {
    'paternal': 'la-paternal',
    'villa-gral-mitre': 'villa-general-mitre',
  };

  // Build { id → { display, geometry } } map. Keep only the geometry (drop
  // properties like commune number, area, etc) to keep the file small.
  const out = {};
  for (const f of geojson.features) {
    if (!f?.properties || !f?.geometry) continue;
    // GCBA's dataset usually exposes the name under one of these keys.
    const rawName =
      f.properties.BARRIO
      || f.properties.barrio
      || f.properties.NOMBRE
      || f.properties.nombre
      || f.properties.NAME;
    if (!rawName) continue;
    const slug = slugify(rawName);
    const id = aliases[slug] || slug;
    out[id] = {
      display: String(rawName).trim(),
      geometry: f.geometry,
    };
  }

  // Report match coverage.
  const matched = [...configIds].filter((id) => out[id]).length;
  const missing = [...configIds].filter((id) => !out[id] && id !== 'vicente-lopez' && id !== 'san-isidro' && id !== 'san-fernando' && id !== 'tigre');
  console.log(
    `matched ${matched}/${configIds.size} CABA neighborhoods (GBA Norte ones don't have a CABA polygon)`,
  );
  if (missing.length) {
    console.warn('missing polygons for:', missing.join(', '));
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`wrote ${Object.keys(out).length} barrios to ${OUT}`);
})();
