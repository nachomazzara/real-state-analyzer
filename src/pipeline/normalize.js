import { homogenize, ageBand, mineAreasFromDescription } from './homogenize.js';
import { classifyStatus, parseFinancedPrice } from './filter.js';
import { toUsd } from '../fx.js';

export function normalize(raw, fxRate) {
  let covered = numOrNull(raw.covered_m2);
  let uncovered = numOrNull(raw.uncovered_m2);
  let total = numOrNull(raw.total_m2);

  // If the scraper missed `uncovered`, try the description for explicit
  // mentions (balcón / terraza / patio / descubiertos). We never mine
  // `covered` or `total` from descriptions — those numbers come from
  // structured features only, otherwise marketing copy contaminates them.
  if (uncovered == null) {
    const mined = mineAreasFromDescription(raw.description);
    if (Number.isFinite(mined.uncovered)) uncovered = mined.uncovered;
  }

  // Derive any missing piece from the other two.
  if (uncovered == null && Number.isFinite(total) && Number.isFinite(covered) && total > covered) {
    uncovered = total - covered;
  }
  if (total == null && Number.isFinite(covered) && Number.isFinite(uncovered)) {
    total = covered + uncovered;
  }
  if (covered == null && Number.isFinite(total) && Number.isFinite(uncovered) && total > uncovered) {
    covered = total - uncovered;
  }

  // Sanity checks: discard internally inconsistent triples rather than
  // propagating bogus numbers downstream. Caller can re-enrich from the
  // detail page to recover real values.
  if (Number.isFinite(covered) && Number.isFinite(total) && covered > total + 1) {
    covered = null;
    uncovered = null;
  }
  if (Number.isFinite(uncovered) && uncovered < 0) uncovered = null;
  if (Number.isFinite(covered) && Number.isFinite(uncovered) && Number.isFinite(total)) {
    // If covered + uncovered diverges from total by >5%, trust covered+total
    // and recompute uncovered (the most common error mode).
    const sum = covered + uncovered;
    if (Math.abs(sum - total) / total > 0.05) {
      uncovered = total > covered ? total - covered : null;
    }
  }

  const homog = homogenize({ covered_m2: covered, uncovered_m2: uncovered, total_m2: total });
  // If the scraper didn't surface an age, try to glean it from the description.
  const ageDirect = numOrNull(raw.age_years);
  const age = ageDirect != null ? ageDirect : extractAgeFromDescription(raw.description);
  let { status, delivery_year } = classifyStatus(raw);

  // Detect financed sales (anticipo + N × cuota) and apply the user's rule:
  // recompute the full price ONLY when the listing's card price matches the
  // anticipo within 1%. If the card already shows the full price (financing
  // is described as an optional payment method), leave both price and status
  // alone. When we DO swap to the full price, also upgrade the status to
  // construccion (or pozo if delivery is in the future) — because the card
  // showing only the anticipo is the tell-tale sign of an off-plan unit.
  let price = numOrNull(raw.price);
  let currency = raw.currency || null;
  const fin = parseFinancedPrice(raw.description);
  if (fin && Number.isFinite(fin.totalPrice) && price != null) {
    const anticipoMatchesPrice = Math.abs(price - fin.anticipo) / fin.anticipo <= 0.01;
    if (anticipoMatchesPrice && fin.totalPrice > price) {
      price = fin.totalPrice;
      currency = fin.currency;
      if (status === 'disponible') status = 'construccion';
    }
  }
  const priceUsd = toUsd(price, currency, fxRate);

  return {
    source: raw.source,
    external_id: String(raw.external_id),
    url: raw.url,
    operation: raw.operation,
    city: raw.city || null,
    neighborhood: raw.neighborhood,
    neighborhood_raw: raw.neighborhood_raw || null,
    property_type: raw.property_type || null,
    rooms: numOrNull(raw.rooms),
    bedrooms: numOrNull(raw.bedrooms),
    bathrooms: numOrNull(raw.bathrooms),
    covered_m2: covered,
    uncovered_m2: uncovered,
    total_m2: total,
    homogenized_m2: homog,
    age_years: age,
    age_band: ageBand(age),
    has_pool: raw.has_pool ? 1 : 0,
    has_amenities: raw.has_amenities ? 1 : 0,
    has_garage: raw.has_garage ? 1 : 0,
    floor: raw.floor || extractFloor(raw.description) || null,
    amenities_json: JSON.stringify(raw.amenities || []),
    price,
    currency,
    price_usd: priceUsd,
    status,
    delivery_year,
    raw_json: safeStringify(raw.raw || {}),
  };
}

// When the scraper failed to surface a structured age, infer from the title/
// description. Returns 0 for "a estrenar", a positive integer for "N años",
// or null if nothing matched.
function extractAgeFromDescription(desc) {
  if (!desc) return null;
  const s = String(desc).toLowerCase();
  if (/\b(a\s*estrenar|a\s*estrnar|estreno|nuevo\s+a\s+estrenar|brand\s+new)\b/i.test(s)) return 0;
  // "16 años antigüedad", "16 años de antigüedad", "antigüedad: 16 años"
  let m = s.match(/(\d{1,3})\s*años?\s*(?:de\s+)?antig/i);
  if (m) return Number(m[1]);
  m = s.match(/antig[üu]edad[:\s]+(\d{1,3})\s*años?/i);
  if (m) return Number(m[1]);
  // "depto de 12 años" — softer signal, only if "años" close to a small number
  m = s.match(/(?:depto|propiedad|inmueble|unidad)\s+de\s+(\d{1,3})\s*años?\b/i);
  if (m) return Number(m[1]);
  return null;
}

// Extract floor of a unit ("piso") from free text. Returns a normalized string
// like "PB", "1", "12", "PH" — null if not detectable.
function extractFloor(desc) {
  if (!desc) return null;
  const s = String(desc);
  // "piso 12", "12° piso", "piso N° 12", "piso: 12"
  const m1 = s.match(/\bpiso\s*[nº°#:]?\s*(\d{1,3})\b/i);
  if (m1) return m1[1];
  const m2 = s.match(/\b(\d{1,3})\s*[°º]\s*piso\b/i);
  if (m2) return m2[1];
  // "Planta Baja", "PB"
  if (/\bplanta\s+baja\b/i.test(s) || /\bP\.?B\.?\b/.test(s)) return 'PB';
  // "PH" properties (typically single-house, but the unit identifier is still useful)
  if (/\bPH\b/.test(s)) return 'PH';
  // "duplex" — annotate
  if (/\bd[uú]plex\b/i.test(s)) return 'duplex';
  return null;
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj).slice(0, 10_000);
  } catch {
    return null;
  }
}

export function isValid(listing) {
  if (!listing.source || !listing.external_id || !listing.url) return false;
  if (!listing.neighborhood || !listing.operation) return false;
  if (listing.price == null || listing.price <= 0) return false;
  if (listing.price_usd == null || listing.price_usd <= 0) return false;
  if (listing.homogenized_m2 == null || listing.homogenized_m2 < 10) return false;
  // Sanity ceiling for `alquiler` (monthly rent). Anything over USD 5.000/mes
  // for residential in CABA is a sale price mis-categorized as rent (the most
  // common offender: ML listings titled "renta inmediata" — they're selling
  // the unit with an active tenant; the price is the sale price). Letting
  // these through poisons the rent_estimate medians used by the yield ranker.
  if (listing.operation === 'alquiler' && listing.price_usd > 5000) return false;
  // Sanity floor for alquiler. Anything below USD 100/mes is a parsing bug
  // (truncated price, "Consultar precio" leak, sublease, etc.) — not a real
  // monthly rent for a residential apartment in CABA.
  if (listing.operation === 'alquiler' && listing.price_usd < 100) return false;
  // Sanity floor for `venta`. A residential apartment in CABA realistically
  // can't cost less than USD 10.000. This catches argenprop "Consultar
  // precio" stale data and truly-broken price extraction. ML cross-bucket
  // contamination (alquiler-in-venta) is now handled by detail-page
  // breadcrumb reclassification in enrich.js, so legitimate alquiler prices
  // (≥$200/mes) won't end up under this floor anymore.
  if (listing.operation === 'venta' && listing.price_usd < 10000) return false;
  return true;
}
