import { getDb } from '../db.js';
import { logger } from '../logger.js';

// USIG is the official Buenos Aires city geocoder (GCBA). No API key, no auth.
// It only resolves addresses inside CABA; everything outside falls through to
// Nominatim. We request output_epsg=4326 so coordinates come back as WGS84
// lat/lng directly — otherwise USIG returns Gauss-Krüger Faja 5 which would
// need a local conversion.
const USIG_URL = 'https://servicios.usig.buenosaires.gob.ar/normalizar/';

// Nominatim is OpenStreetMap's free geocoder. Strict rate limit (1 req/s) and
// requires a real User-Agent identifying the application — we comply.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_UA = 'real-state-analyzer/1.0 (https://github.com/nacho/real-state-analyzer)';

// Serialize Nominatim calls: it bans clients that exceed 1 req/s.
let lastNominatimAt = 0;
async function nominatimGate() {
  const elapsed = Date.now() - lastNominatimAt;
  const wait = 1100 - elapsed;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimAt = Date.now();
}

function normalizeKey(addressText) {
  if (!addressText) return null;
  return String(addressText)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/\s+/g, ' ')
    .trim();
}

// Clean a raw address string before sending it to USIG/Nominatim. ML and
// Remax give us text like:
//   - "Ruiz Huidobro Al 3000, Núñez, Capital Federal"     ← "Al" prefix
//   - "Av. Cabildo 4667 Al 4600, Núñez, Capital Federal"  ← double-altura
//   - "GARCIA DEL RIO Al 4041. Entre Estomba Y Tronador"  ← post-period extras
// Both geocoders choke on the "Al", trailing context, and "Entre X Y Z"
// references. This cleaner drops all of that so we send just the canonical
// "street altura" (e.g. "Ruiz Huidobro 3000") that geocoders actually parse.
export function cleanAddressForGeocoding(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // 1) Strip parenthetical content first. Listings often add "(piso 4)",
  //    "(libertador 7500)", "(baño en suite)" etc. that confuse parsing.
  s = s.replace(/\([^)]*\)/g, ' ');

  // 1a) Normalize "&" as an intersection separator. Sellers write
  //     "Deheza & Av. Cabildo" meaning the corner. Convert to " y " so
  //     the rest of the cleaner and the geocode() intersection branches
  //     (which look for "y"/"esquina"/"esq.") just work.
  s = s.replace(/\s*&\s*/g, ' y ');

  // 1a2) Normalize the Spanish euphony conjunction "e" (used in place of
  //      "y" before words starting with i/hi) to plain "y". Catches
  //      "Montañeses e Iberá", "Olleros e Ibíricu". Restricted to the
  //      i/hi-prefix case so we don't mangle random " e " in mid-word.
  s = s.replace(/\s+e\s+(?=[IiHh])/g, ' y ');

  // 1c) Strip "Boulevard"/"Bv."/"Bvar." street-type prefix. USIG doesn't
  //     index it as a type — the CABA catalog stores e.g.
  //     "COMODORO MARTIN RIVADAVIA" with no "Boulevard" — so the prefix
  //     causes USIG to return no match. Av./Avda. are NOT stripped here
  //     since USIG does recognize them.
  s = s.replace(/\b(?:Boulevard|Bvar?\.?|Bv\.)\s+/gi, '');

  // 1b) " - " splits the seller's address from contextual junk. Three
  //     legitimate shapes (decided by which side carries the altura):
  //       "STREET ALTURA - <anything>"        → keep the PREFIX
  //       "BARRIO - STREET ALTURA"            → keep the SUFFIX
  //       neither side has altura             → leave as-is
  //     Old logic used a negative lookahead to skip "- Piso/Unidad/…", but
  //     with explicit altura detection the lookahead is redundant — if the
  //     prefix has altura we keep it regardless of what the suffix is.
  {
    const m = s.match(/^(.{2,80}?)\s+-\s+(.+)$/i);
    if (m) {
      const before = m[1];
      const after = m[2];
      const beforeHasAltura = /\s\d{2,5}\b/.test(before) || /\bal\s+\d{2,5}\b/i.test(before);
      const afterHasAltura = /\s\d{2,5}\b/.test(after) || /\bal\s+\d{2,5}\b/i.test(after);
      if (beforeHasAltura) s = before.trim();
      else if (afterHasAltura) s = after.trim();
    }
  }

  // 2) Decode HTML entities (named + numeric) the source HTML kept.
  //    Numeric entities like &#039; (apostrophe) appear in street names
  //    such as "O'Higgins" → "O&#039;Higgins".
  s = s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#xF1;/gi, 'ñ');
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

  // 3) "Entre X y Y" cross-street reference. Three sub-cases by altura
  //    position (\d{2,5} — 1-digit tokens like "3 De Febrero" don't count):
  //      (a) altura BEFORE "entre"  — strip "Entre …" through end. The
  //          altura is the address; the cross-streets are disambiguation.
  //          Catches "QUIROGA, HORACIO 1900. Entre 3 De Febrero y Grecia".
  //      (b) altura AT END (after entre)  — strip everything between the
  //          pre-entre street and the trailing altura. Catches
  //          "Migueletes entre Olleros y Gorostiaga 2 1068" → "Migueletes 1068".
  //      (c) no altura anywhere  — convert "Entre" → "e/" so the
  //          downstream entre-midpoint logic in geocode() can geocode
  //          both cross-streets and average them. Catches
  //          "AV. SAN Isidro Entre Ruiz Huidobro y Correa".
  // 3pre) "Entre  y Y" / "Entre, y Y" — seller omitted the first cross-street.
  //       Drop "Entre" so the rest reads as a normal "MAIN y Y" corner.
  //       Catches "11 DE Setiembre Entre  y Vedia" → "11 DE Setiembre y Vedia".
  s = s.replace(/\s*\.?\s*\bentre\s*[,.]?\s*y\s+/i, ' y ');
  if (/\bentre\b/i.test(s)) {
    const entreIdx = s.search(/\bentre\b/i);
    const preEntre = s.slice(0, entreIdx);
    const postEntre = s.slice(entreIdx);
    // Altura check requires `\s\d{2,5}` (space-prefixed) — digits at the very
    // start of the string ("11 de Septiembre") are part of a date-named
    // street name, not an altura.
    if (/\s\d{2,5}\b/.test(preEntre)) {
      s = s.replace(/\s*\.?\s*\bentre\b.*$/i, '');
    } else {
      const tail = postEntre.match(/\s+(\d{2,5})\s*$/);
      if (tail) {
        s = `${preEntre.trim()} ${tail[1]}`;
      } else {
        s = s.replace(/\s*\.?\s*\bentre\b/i, ' e/');
      }
    }
  }
  // 3b) Strip 1-digit "doorbell" tokens that sit between the street and
  //     the altura ("Migueletes 2 1068" → "Migueletes 1068"). These are
  //     not real alturas (real ones are 2–5 digits).
  s = s.replace(/\b\d\b\s+(?=\d{2,5}\b)/g, '');

  // 4) "STREET N1 Al N2" → "STREET N1" (keep first altura)
  //    "STREET Al N"     → "STREET N"  (promote N to altura)
  if (/\b\d{2,5}\s+Al\s+\d{2,5}\b/i.test(s)) {
    s = s.replace(/\s+Al\s+\d{2,5}\b/i, '');
  } else {
    s = s.replace(/\s+Al\s+(\d{2,5})\b/i, ' $1');
  }

  // 5) Smart trim — KEEP the street+altura, DROP the trailing context.
  //    The naive `split(',')[0]` was wrong because some catalog streets
  //    legitimately contain commas in their name (e.g. "FREIRE, CAP. GRAL.
  //    R." or "LUGONES, LEOPOLDO").
  //    Strategy:
  //      a) If the string ends in ", Capital Federal" / ", CABA" /
  //         ", Buenos Aires", strip that suffix (one or two trailing
  //         comma-segments for the city/barrio).
  //      b) If an altura (\d{2,5}) appears in the string, cut right after
  //         it — this keeps any commas in the street name AND drops
  //         "Piso N" / barrio context that follows the altura.
  //      c) Otherwise (no altura — intersection-style address), leave as-is
  //         after the city strip.
  s = s.replace(/(,\s*[^,]+)?(,\s*(?:Capital\s+Federal|CABA|Buenos\s+Aires))\s*$/i, '').trim();
  // 5a) Drop a trailing single-digit "altura" — sellers truncate ("Av.
  //     Libertador 8" instead of "8200") or paste stray digits. Real
  //     alturas are 2-5 digits, so a bare 1-digit at end is junk that
  //     would otherwise survive into the intersection branch and break
  //     the USIG corner lookup. Runs AFTER city-strip so the digit is
  //     actually at end-of-string by now.
  s = s.replace(/\s+\b\d\b\s*$/, '').trim();
  // 5b) Marketing-prefix strip. Sellers write "Excelente Edificio con
  //     Amenities. Av. Cabildo 4600 Piso 5º. Núñez." — the leading
  //     "Excelente Edificio …" would otherwise trip the step 8 reject
  //     check ("excelente"/"amenities" → null). If we can split on ". "
  //     and the PREFIX has no altura but the SUFFIX does, the prefix is
  //     marketing fluff — keep only the suffix.
  //     Guards: require ≥2 words in the prefix so we don't strip a real
  //     street type ("Av. Cabildo 4500" → prefix "Av" has 1 word → skip).
  //     Suffix allows a lowercase article ("de"/"del"/"la"/"los") after
  //     the street-type so "Av. del Libertador 7700" matches.
  {
    const dotSplit = s.match(/^(.+?)\.\s+((?:Av\.?\s+|Avda\.?\s+|Bv\.?\s+|Pje\.?\s+|Gral\.?\s+|Dr\.?\s+)?(?:(?:de(?:l)?|la|las|los)\s+)?[A-ZÁÉÍÓÚÑ][\w.áéíóúñ']*(?:\s+[^\d.]+?)*\s+\d{2,5}\b.*)$/);
    if (dotSplit && /\s/.test(dotSplit[1]) && !/\s\d{2,5}\b/.test(dotSplit[1])) {
      s = dotSplit[2].trim();
    }
  }
  const alturaCut = s.match(/^(.+?\s\d{2,5})\b/);
  if (alturaCut) s = alturaCut[1].trim();

  // 5b) Intersection-style address (no altura, contains "y"/"esquina"):
  //     strip trailing junk from the right side. Two passes:
  //       1) drop trailing ", BARRIO" segments with no digits (handles
  //          "Deheza y Av. Cabildo, Lomas de Núñez, Núñez").
  //       2) if commas remain, keep only up to the first one — this kills
  //          seller-pasted address dumps like "Av. del Libertador, C1429
  //          Cdad. Autónoma de Buenos Aires, Argentina, Núñez, Capital
  //          Federal, Argentina." where the postal code's digit broke
  //          pass 1.
  //     We split on the FIRST intersection marker so a catalog-format
  //     left-side ("PEDRAZA, MANUELA y X") keeps its commas intact.
  if (!/\d{2,5}\s*$/.test(s) && /(\sy\s|\besquina\b|\besq\.)/i.test(s)) {
    const im = s.match(/^(.+?)\s+(y|esquina|esq\.?)\s+(.+)$/i);
    if (im) {
      let right = im[3].replace(/(,\s*[^,\d]+)+\s*$/, '').trim();
      if (right.includes(',')) right = right.split(',')[0].trim();
      s = `${im[1]} ${im[2]} ${right}`;
    }
  }

  // 6) Lowercase ALL-CAPS words ("GARCIA DEL RIO" → "Garcia Del Rio").
  s = s.replace(/\b([A-ZÁÉÍÓÚÑ])([A-ZÁÉÍÓÚÑ]{2,})\b/g, (_, a, b) => a + b.toLowerCase());

  // 7) Strip post-altura noise. Order matters — strip the most-specific
  //    patterns first so the leftover is just "STREET ALTURA".
  //    - "|| WORD" / "| WORD" separator junk ("Piso 11 || COCHERA")
  //    - "Piso N", "- Piso N", "Piso N Y M"
  //    - "Depto N", "Dto N", "Unidad N", "U N"
  s = s.replace(/\s*\|\|?\s+\S.*$/i, '');
  s = s.replace(/\s*-?\s*\bPiso\b\s*\d+\s*(?:Y\s*\d+)?.*$/i, '');
  // Multi-letter abbreviations (depto/dto/unidad) followed by anything.
  s = s.replace(/\s+\b(?:depto|dto|unidad)\b\s*\.?\s*\w+.*$/i, '');
  // Bare "U" stands for "unidad" ONLY when followed by a digit ("U 5", "u.12").
  // Without the digit-anchor, this regex would eat the U in real street names
  // like "Manuel Ugarte 1800" → "Manuel".
  s = s.replace(/\s+\bu\b\s*\.?\s*\d+.*$/i, '');
  // 7b) Strip seller-injected amenity words sitting between the street and
  //     the altura ("Av. del Libertador con Cochera 7700"). Without this,
  //     the reject check below would kill the whole address because
  //     "cochera"/"balcón"/etc. are in the title-noise list.
  s = s.replace(/\s+(?:con|sin|y)\s+(?:cochera|patio|pileta|balc[oó]n|baulera|amenities|terraza|jard[ií]n|parrilla|quincho)\b/gi, '');
  // 7c) Strip marketing-style prefixes that wrap the actual address
  //     ("Venta Departamento 3 ambientes Nuñez Manuel Ugarte CABA 1500" →
  //     "Manuel Ugarte CABA 1500"). The reject check below would kill the
  //     whole address otherwise. Order matters: drop the operation +
  //     property-type + ambientes count first, then the bare "CABA" infix.
  s = s.replace(/\b(?:venta|alquiler|alquila|vende|se\s+vende|se\s+alquila)\s+/gi, '');
  s = s.replace(/\b(?:departamento|depto|casa|ph|monoambiente)\s+/gi, '');
  // Match both "ambientes" (full) and "amb" / "amb." (abbreviation) for the
  // "N ambientes" leading-junk pattern: "Venta 4 amb O´higgins Nuñez".
  s = s.replace(/\b\d+\s+(?:ambientes?|amb\.?)\s+/gi, '');
  s = s.replace(/\b(?:CABA|Capital\s+Federal)\s+(?=\d{2,5}\b)/gi, '');
  // Normalize unicode apostrophe variants in street names: sellers paste
  // "O´higgins" (acute accent), "O’Higgins" (right single quote), or
  // "O`Higgins" (backtick) — USIG only accepts ASCII apostrophe "'".
  s = s.replace(/[´`’ʼ‘]/g, "'");

  // 8) NOW reject if the remaining string looks like title text (m²,
  //    ambientes, etc). Doing this AFTER stripping the suffixes means
  //    "Avenida Congreso 2641 Piso 11 || COCHERA" cleans down to "Avenida
  //    Congreso 2641" first, which is a valid address.
  if (/(\bm[2²](?!\w)|\bambientes?\b|\balquiler\b|\bventa\b|\bmonoambiente\b|\bdepto\b|\bdepartamento\b|\bexcelente\b|\bcfte\b|\bbcon\b|\bbalc[oó]n\b|\bsuite\b|\bcochera\b|\blavadero\b|\bvestidor|\bamenities\b|\ba\s+estrenar\b|\bapto\s+profesional\b|\bcalidad\s+y\s+buen\s+gusto\b)/i.test(s)) {
    return null;
  }

  // 9) Strip leading title noise: "1 Amb", "2 Amb", "3 Amb",
  //    "Monoambiente", "Depto", "Exc.", "Excelente" at start of string.
  s = s.replace(/^\s*(?:\d+\s+amb\b|monoamb\w*|depto\.?|departamento|exc\.?|excelente)\s+/i, '');

  // 10) Strip trailing "Capital Federal", "CABA", or barrio names that
  //     survived the comma split (when the input had no commas).
  s = s.replace(/\s+(?:Capital\s+Federal|CABA)$/i, '');
  // 10b) Strip trailing dangling punctuation ("- ", ", ", ".", " -", "-").
  //      Common after step 7's Piso/Unidad strip eats a suffix and leaves a
  //      lone separator: "Montañeses y Iberá - Unidad 1A" → step 7 strips
  //      " Unidad 1A" → "Montañeses y Iberá -" → this rule trims the " -".
  s = s.replace(/[\s,.\-]+$/, '').trim();

  // 11) Strip apartment unit indicators after the altura: "4C", "º", "A"
  //     standalone, "2 04" extras, etc. We keep only "STREET ALTURA".
  //     Match the pattern "[street tokens] NNNN [optional junk]" and trim
  //     to just the part up to and including the first valid altura.
  {
    const m = s.match(/^(.+?\s+\d{2,5})\b/);
    if (m) s = m[1];
  }

  // 12) Collapse spaces.
  s = s.replace(/\s+/g, ' ').trim();

  // 13) Auto-capitalize the first letter (Spanish streets sometimes start
  //     with "de", "del", "la"). 228 CABA streets begin with an article
  //     ("La Pampa", "El Salvador", "Las Heras General") — don't reject on
  //     that alone; step 8 above already catches marketing-text prefixes.
  s = s.charAt(0).toUpperCase() + s.slice(1);
  // Intersection patterns DON'T need an altura — "Arcos e/ Núñez y
  // Crisólogo Larralde" and "Av. del Libertador y Av. Congreso" are valid
  // addresses (corner / between cross-streets) that USIG can geocode.
  const isIntersection = /(\se\/\s|\besquina\b|\besq\.|\sy\s)/i.test(s) && !/\d{2,5}\s*$/.test(s);
  if (!isIntersection) {
    if (!/^\S.*\s\d{2,5}$/.test(s)) return null;
  }
  if (s.length < 5) return null;
  return s;
}

// Rough bounding box for CABA + AMBA (greater Buenos Aires). We discard any
// geocode that falls outside this region because the address text occasionally
// contains junk that USIG/Nominatim happily resolve to a city far away (e.g.
// "Ramallo" → 700km north). Listings in our DB are all from CABA neighborhoods
// so anything outside this box is definitely wrong.
const CABA_AMBA_BOUNDS = {
  latMin: -35.0,
  latMax: -34.3,
  lngMin: -58.8,
  lngMax: -58.2,
};
function inCabaBounds(lat, lng) {
  return lat >= CABA_AMBA_BOUNDS.latMin && lat <= CABA_AMBA_BOUNDS.latMax
    && lng >= CABA_AMBA_BOUNDS.lngMin && lng <= CABA_AMBA_BOUNDS.lngMax;
}
// Tight CABA-proper bounds (excludes Almirante Brown, Lanús, Vicente López,
// etc). Used to trigger swap/fuzzy recovery — when USIG resolves a
// same-named street in another partido (e.g. "Quiroga, Horacio" → Horacio
// Quiroga in Almirante Brown instead of CABA's Núñez), the loose AMBA
// check would accept the wrong result; this stricter check forces a retry.
function inCabaProperBounds(lat, lng) {
  return lat >= -34.71 && lat <= -34.53 && lng >= -58.55 && lng <= -58.33;
}

function readCache(key) {
  const db = getDb();
  const row = db.prepare('SELECT lat, lng, source, normalized FROM geocode_cache WHERE address_key = ?').get(key);
  return row || null;
}

function writeCache(key, result) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO geocode_cache (address_key, lat, lng, source, normalized, geocoded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(key, result.lat, result.lng, result.source, result.normalized || null, Date.now());
}

async function geocodeUsig(addressText) {
  const url = new URL(USIG_URL);
  url.searchParams.set('direccion', addressText);
  url.searchParams.set('geocodificar', 'TRUE');
  url.searchParams.set('output_epsg', '4326');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    // USIG response shape: { direccionesNormalizadas: [{ nomenclatura, coordenadas: { x, y } | { lat, lng } }] }
    // With output_epsg=4326, coordenadas usually contains lng/lat as x/y.
    const first = data?.direccionesNormalizadas?.[0];
    if (!first) return null;
    const coords = first.coordenadas || first;
    // Try multiple field-name conventions: USIG has varied across versions.
    const lat = Number(coords.lat ?? coords.latitud ?? coords.y);
    const lng = Number(coords.lng ?? coords.lon ?? coords.longitud ?? coords.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    // Sanity check: CABA is bounded roughly by lat -34.7..-34.5, lng -58.55..-58.33.
    // If USIG returned Gauss-Krüger by accident (huge x,y), discard.
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return {
      lat,
      lng,
      source: 'usig',
      normalized: first.nomenclatura || null,
    };
  } catch (err) {
    logger.debug({ err: err.message, addressText }, 'usig geocode failed');
    return null;
  }
}

async function geocodeNominatim(addressText) {
  await nominatimGate();
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', addressText);
  url.searchParams.set('format', 'json');
  url.searchParams.set('countrycodes', 'ar');
  url.searchParams.set('limit', '1');
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const arr = await res.json();
    const first = Array.isArray(arr) ? arr[0] : null;
    if (!first) return null;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat,
      lng,
      source: 'nominatim',
      normalized: first.display_name || null,
    };
  } catch (err) {
    logger.debug({ err: err.message, addressText }, 'nominatim geocode failed');
    return null;
  }
}

// Public API. Returns { lat, lng, source, normalized } | null. Caches on hit;
// returns null without caching on miss (so we can retry later when providers
// recover or the address gets cleaned up).
export async function geocode(addressText) {
  const key = normalizeKey(addressText);
  if (!key) {
    logger.warn({ addressText }, '[GEOCODE] empty key — null');
    return null;
  }
  const cached = readCache(key);
  if (cached) {
    if (cached.lat == null || cached.lng == null) return null;
    if (!inCabaBounds(cached.lat, cached.lng)) return null;
    return { lat: cached.lat, lng: cached.lng, source: cached.source, normalized: cached.normalized };
  }
  // Clean the address before hitting either provider. The raw text from ML/
  // Remax has "Al NNNN", trailing barrio/city context, "Entre X Y Z" notes —
  // all of which geocoders choke on.
  const cleaned = cleanAddressForGeocoding(addressText);
  if (!cleaned) {
    logger.warn({ addressText: addressText.slice(0, 80) }, '[GEOCODE] could not normalize — null');
    return null;
  }
  if (cleaned !== addressText) {
    logger.info({ raw: addressText.slice(0, 60), cleaned }, '[GEOCODE] cleaned address');
  }
  // If the raw text mentions "Capital Federal" / "CABA", the listing is in
  // CABA proper — use tight bounds for recovery triggers so we retry when
  // USIG resolves to a same-named street in another AMBA partido (e.g.
  // "Quiroga, Horacio 1900" → Almirante Brown, "Casco" → Lanús). GBA Norte
  // listings (Vicente López, Tigre, San Isidro) use the looser AMBA check.
  const isCabaHint = /\b(capital\s+federal|caba)\b/i.test(addressText);
  const inBounds = (lat, lng) => isCabaHint
    ? inCabaProperBounds(lat, lng)
    : inCabaBounds(lat, lng);
  // USIG primary (CABA only), Nominatim fallback (global AR).
  let result = null;
  let usedSource = 'usig';
  let triedNeighbor = null;
  let fuzzyCorrected = null;
  let intersectionVariant = null;

  // No-altura intersections — addresses like "STREET1 y STREET2",
  // "STREET1 esquina STREET2", or "MAIN e/ CROSS1 y CROSS2" don't have a
  // building altura but ARE valid geocodable corners/segments. Handle them
  // BEFORE the regular USIG attempt so we route directly to USIG's
  // intersection syntax ("X y Y").
  if (!/\d{2,5}\s*$/.test(cleaned)) {
    // Pattern: "MAIN e/ CROSS1 y CROSS2" — listing is on MAIN between
    // CROSS1 and CROSS2. Geocode both corners and average for a midpoint.
    const entreMatch = cleaned.match(/^(.+?)\s+e\/\s+(.+?)\s+y\s+(.+)$/i);
    if (entreMatch) {
      const main = entreMatch[1].trim();
      const cross1 = entreMatch[2].trim();
      const cross2 = entreMatch[3].trim();
      const [r1, r2] = await Promise.all([
        geocodeUsig(`${main} y ${cross1}`),
        geocodeUsig(`${main} y ${cross2}`),
      ]);
      const good1 = r1 && inBounds(r1.lat, r1.lng) ? r1 : null;
      const good2 = r2 && inBounds(r2.lat, r2.lng) ? r2 : null;
      if (good1 && good2) {
        result = { lat: (good1.lat + good2.lat) / 2, lng: (good1.lng + good2.lng) / 2, source: 'usig', normalized: `${main} entre ${cross1} y ${cross2}` };
        intersectionVariant = { kind: 'entre-midpoint', main, cross1, cross2 };
      } else if (good1) {
        result = good1;
        intersectionVariant = { kind: 'entre-cross1', tried: `${main} y ${cross1}` };
      } else if (good2) {
        result = good2;
        intersectionVariant = { kind: 'entre-cross2', tried: `${main} y ${cross2}` };
      }
    }
    // Pattern: "STREET1 esquina STREET2" or "STREET1 y STREET2" — plain
    // corner with no altura. USIG resolves the corner coord directly.
    if (!result) {
      const cornerMatch = cleaned.match(/^(.+?)\s+(?:esquina|esq\.|y)\s+(.+)$/i);
      if (cornerMatch) {
        const street1 = cornerMatch[1].trim();
        const street2Raw = cornerMatch[2].trim();
        // Progressive tail-strip on street2 — sellers append building names
        // ("Av. Libertador Parque De La Innovacion") that USIG can't parse.
        // Try the full form first, then drop trailing words until the corner
        // resolves in CABA.
        const s2Words = street2Raw.split(/\s+/);
        const maxDrop = Math.min(5, s2Words.length - 1);
        for (let drop = 0; drop <= maxDrop; drop++) {
          const s2 = s2Words.slice(0, s2Words.length - drop).join(' ');
          if (s2.length < 3) break;
          const r = await geocodeUsig(`${street1} y ${s2}`);
          if (r && inBounds(r.lat, r.lng)) {
            result = r;
            intersectionVariant = {
              kind: drop === 0 ? 'corner-no-altura' : 'corner-no-altura-tail-strip',
              tried: `${street1} y ${s2}`,
            };
            break;
          }
        }
      }
    }
  }
  // Standard path when no intersection branch fired (or it failed).
  if (!result) {
    result = await geocodeUsig(cleaned);
  }
  // LAST, FIRST → FIRST LAST swap. CABA's official catalog stores some
  // streets as "QUIROGA, HORACIO" — when sellers copy that form into the
  // address, USIG resolves to the same-name street in another partido
  // (Almirante Brown for Quiroga, Lanús for Casco, etc), failing the CABA
  // bounds check. Retry with the natural-order form, which catalog also
  // indexes ("HORACIO QUIROGA"). Skip when the second token is a street-
  // type abbreviation ("Cabildo, Avda.") — that's not a person's name.
  if (!result || (result && !inBounds(result.lat, result.lng))) {
    const m = cleaned.match(/^([^,]+),\s+([^,]+?)\s+(\d{2,5})\s*$/);
    if (m) {
      const last = m[1].trim();
      const first = m[2].trim();
      const altura = m[3];
      if (!/^(?:av|avda|calle|pasaje|pje|diag|bv|bvar)\.?$/i.test(first)) {
        const swapped = `${first} ${last} ${altura}`;
        const r = await geocodeUsig(swapped);
        if (r && inBounds(r.lat, r.lng)) {
          result = r;
          usedSource = 'usig';
          logger.info({ raw: cleaned, swapped }, '[GEOCODE] recovered via LAST,FIRST → FIRST LAST swap');
        }
      }
    }
  }
  // Intersection recovery: when the seller writes "X Esquina Y 208" /
  // "X y Y 208" they mean "the corner of X and Y" — the altura is
  // approximate. The corner coords are exact (it's a unique geographic
  // point), so we ask USIG for those FIRST. If the corner doesn't resolve
  // (e.g. typos in either street name), fall back to per-street altura.
  if (!result || (result && !inBounds(result.lat, result.lng))) {
    const m = cleaned.match(/^(.+?)\s+(?:esquina|esq\.?|y)\s+(.+?)\s+(\d{2,5})\s*$/i);
    if (m) {
      const s1Raw = m[1].trim();
      const s2 = m[2].trim();
      const altura = m[3];
      // Build the variant list. For street1 we ALSO try progressive
      // leading-word drops — sellers often prefix building names ("Torre
      // Quantum Libertador y Núñez al 7400" → strip "Torre Quantum").
      const s1Words = s1Raw.split(/\s+/).filter(Boolean);
      const s1Variants = [s1Raw];
      for (let drop = 1; drop < s1Words.length && drop <= 3; drop++) {
        const sub = s1Words.slice(drop).join(' ');
        if (sub.length >= 3) s1Variants.push(sub);
      }
      const variants = [];
      for (const s1 of s1Variants) variants.push([`${s1} y ${s2}`, s1 === s1Raw ? 'corner' : 'corner-stripped']);
      variants.push([`${s1Raw} ${altura}`, 'street1']);
      variants.push([`${s2} ${altura}`, 'street2']);
      for (const [variant, kind] of variants) {
        const r = await geocodeUsig(variant);
        if (r && inBounds(r.lat, r.lng)) {
          result = r;
          intersectionVariant = { tried: variant, kind };
          logger.info({ raw: cleaned, variant, kind }, '[GEOCODE] intersection variant matched');
          break;
        }
      }
    }
  }
  // Typo recovery: when USIG returns nothing for a CABA-looking address, the
  // street name is probably misspelled by the seller ("Daheza" → "Deheza",
  // "Ohggins" → "O'Higgins"). Look up the closest match in the official
  // callejero (Damerau-Levenshtein ≤ 2) and retry USIG with the corrected
  // street. Cheap: catalog is in memory after first load.
  if (!result) {
    const { findClosestStreet, splitStreetAndAltura } = await import('./street-fuzzy.js');
    const parts = splitStreetAndAltura(cleaned);
    if (parts) {
      // Strip street-type prefixes ("Av.", "Avda.", "Calle") before fuzzy
      // matching — the catalog stores names without them.
      const stem = parts.street.replace(/^(av\.?|avda\.?|calle|pasaje|pje\.?|diag\.?)\s+/i, '');
      // Variants to fuzzy-match. Tries the original stem first, then
      // common missing-space typos like "Septiembrede" → "Septiembre de"
      // (date-named streets where the seller dropped a space).
      const variants = [stem];
      const desplit = stem.replace(/([a-záéíóúñ]{4,})(de|del)\b/i, '$1 $2');
      if (desplit !== stem) variants.push(desplit);
      for (const v of variants) {
        const match = findClosestStreet(v);
        if (match && match.distance > 0) {
          const corrected = `${match.display} ${parts.altura}`;
          result = await geocodeUsig(corrected);
          if (result) {
            fuzzyCorrected = { from: parts.street, to: match.display, distance: match.distance, variant: v };
            logger.info({ raw: cleaned, corrected, variant: v, distance: match.distance }, '[GEOCODE] fuzzy-corrected typo');
            break;
          }
        }
      }
    }
  }
  // Altura sweep (run BEFORE Nominatim fallback so we exhaust the cheap USIG
  // recovery options first). Triggers in two cases:
  //   (a) USIG returned nothing (e.g. "Ramallo 1600" — street exists but
  //       altura 1600 doesn't, USIG returns "Calle inexistente"). The street
  //       starts at altura 1700 — we need to jump ±100, not ±3.
  //   (b) USIG returned a result that's outside CABA (e.g. "García del Río
  //       2400" — USIG fell back to a same-name street in Moreno, ~30km
  //       west). A ±2 nudge usually finds the real CABA altura.
  // Combined sweep tries small deltas first (cheap, common case) then bigger
  // jumps (for far-off altura mismatches). Stops at first CABA match.
  if (!result || (result && !inBounds(result.lat, result.lng))) {
    const m = cleaned.match(/^(.+?)\s+(\d{2,5})\s*$/);
    if (m) {
      const stem = m[1];
      const baseAltura = Number(m[2]);
      const deltas = [1, -1, 2, -2, 3, -3, 5, -5, 10, -10, 25, -25, 50, -50, 100, -100, 200, -200];
      for (const delta of deltas) {
        const tryAltura = baseAltura + delta;
        if (tryAltura < 1) continue;
        const tryAddr = `${stem} ${tryAltura}`;
        const r = await geocodeUsig(tryAddr);
        if (r && inBounds(r.lat, r.lng)) {
          logger.info(
            { cleaned, fallbackTo: tryAddr, delta },
            '[GEOCODE] recovered via ±altura sweep',
          );
          result = r;
          usedSource = 'usig';
          triedNeighbor = tryAltura;
          break;
        }
      }
    }
  }
  // Word-strip recovery: when USIG still hasn't matched, the street name
  // may have extra prefix tokens the seller added that aren't part of the
  // real street:
  //   "Ignacio Nuñez 2452"            → drop "Ignacio" → "Nuñez 2452"
  //   "J De Amenabar 3133"            → drop "J De" → "Amenabar 3133"
  //   "Spacio Vivant, nuñez 2700"     → drop "Spacio Vivant," → "nuñez 2700"
  // We try comma-prefix split first (cleaner heuristic when present), then
  // progressive leading-word drops as fallback. First CABA match wins.
  let wordStripped = null;
  if (!result) {
    const { splitStreetAndAltura, findClosestStreet } = await import('./street-fuzzy.js');
    const parts = splitStreetAndAltura(cleaned);
    if (parts) {
      const variants = [];
      // Variant A: if there's a comma in the street, try the part AFTER
      // the comma (drops building names: "Spacio Vivant, nuñez").
      if (parts.street.includes(',')) {
        const afterComma = parts.street.split(',').pop().trim();
        if (afterComma.length >= 3) variants.push({ kind: 'comma-strip', street: afterComma });
      }
      // Variant B: progressively drop leading words.
      //   "Ignacio Nuñez 2452"            → drop "Ignacio" → "Nuñez 2452"
      //   "J De Amenabar 3133"            → drop "J De" → "Amenabar 3133"
      const words = parts.street.split(/\s+/).filter(Boolean);
      for (let drop = 1; drop < words.length && drop <= 3; drop++) {
        const subStreet = words.slice(drop).join(' ');
        if (subStreet.length >= 3) variants.push({ kind: `word-drop-${drop}`, street: subStreet });
      }
      // Variant C: progressively drop trailing words. Some sellers append
      // honorifics or full names that USIG doesn't index:
      //   "Av del Libertador Gral San Martin 7400" → drop "Gral San Martin"
      //   "Av Cabildo Av 4000" → drop trailing "Av"
      // Leave at least 1 word (the bare street root).
      for (let drop = 1; drop < words.length && drop <= 3; drop++) {
        const subStreet = words.slice(0, words.length - drop).join(' ');
        if (subStreet.length >= 3) variants.push({ kind: `word-drop-tail-${drop}`, street: subStreet });
      }
      for (const v of variants) {
        const tryAddr = `${v.street} ${parts.altura}`;
        let r = await geocodeUsig(tryAddr);
        if (!r) {
          const m = findClosestStreet(v.street);
          if (m && m.distance > 0) r = await geocodeUsig(`${m.display} ${parts.altura}`);
        }
        if (r && inBounds(r.lat, r.lng)) {
          result = r;
          usedSource = 'usig';
          wordStripped = { from: parts.street, to: v.street, kind: v.kind };
          logger.info({ raw: cleaned, tried: tryAddr, kind: v.kind }, '[GEOCODE] recovered via prefix-strip');
          break;
        }
      }
      // Last-resort: substring-match the catalog. Catches mangled inputs
      // where a real street name is embedded in garbage ("CiudCiudad de la
      // Paz ad de la Paz" → catalog substring "ciudad de la paz").
      if (!result) {
        const { findStreetSubstring } = await import('./street-fuzzy.js');
        const sub = findStreetSubstring(parts.street);
        if (sub) {
          const r = await geocodeUsig(`${sub.display} ${parts.altura}`);
          if (r && inBounds(r.lat, r.lng)) {
            result = r;
            usedSource = 'usig';
            wordStripped = { from: parts.street, to: sub.display, kind: 'substring' };
            logger.info({ raw: cleaned, tried: `${sub.display} ${parts.altura}`, kind: 'substring' }, '[GEOCODE] recovered via substring-match');
          }
        }
      }
    }
  }
  if (!result) {
    result = await geocodeNominatim(cleaned + ', Buenos Aires, Argentina');
    usedSource = 'nominatim';
  }
  if (!result) {
    logger.warn({ cleaned }, '[GEOCODE] BOTH providers failed');
    return null;
  }
  if (!inBounds(result.lat, result.lng)) {
    logger.warn(
      { cleaned, lat: result.lat, lng: result.lng, source: result.source },
      '[GEOCODE] OUT OF BOUNDS — rejecting (even after ±altura sweep)',
    );
    return null;
  }
  writeCache(key, result);
  logger.info(
    { cleaned, source: usedSource, neighborAltura: triedNeighbor, fuzzy: fuzzyCorrected, intersectionVariant, wordStripped },
    '[GEOCODE] OK',
  );
  return result;
}
