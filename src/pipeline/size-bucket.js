// Size-aware classification for listings. A "2 amb de 100m²" is structurally
// a different product than a "2 amb de 45m²" — same room count, different
// market segment. Mixing both into the same median masks both. We split each
// rooms count into chico/normal/grande based on homogenized_m2.
//
// Buckets per spec:
//   Mono          : 1 amb (cualquier m², típicamente 25-40)
//   2 amb chico   : 2 amb, <50 m²
//   2 amb normal  : 2 amb, 50-70 m²
//   2 amb grande  : 2 amb, ≥70 m² (incluye premium 100+)
//   3 amb chico   : 3 amb, <70 m²
//   3 amb normal  : 3 amb, 70-90 m²
//   3 amb grande  : 3 amb, ≥90 m² (incluye premium 120+)
//   4+ amb        : 4 o más amb (cualquier m²)
//   PH / casa     : property_type PH o casa (no se mezcla con dpto)

export const SIZE_BUCKETS = [
  '1-mono',
  '2-chico', '2-normal', '2-grande',
  '3-chico', '3-normal', '3-grande',
  '4+',
  'ph-casa',
];

// Human-readable labels for the UI.
export const SIZE_BUCKET_LABELS = {
  '1-mono':   'Mono',
  '2-chico':  '2 amb chico',
  '2-normal': '2 amb normal',
  '2-grande': '2 amb grande',
  '3-chico':  '3 amb chico',
  '3-normal': '3 amb normal',
  '3-grande': '3 amb grande',
  '4+':       '4+ amb',
  'ph-casa':  'PH / casa',
};

// SQL-friendly filter description: { rooms_eq, rooms_gte, m2_min, m2_max,
// property_type_in }. Consumers (rent-match) translate this into WHERE
// clauses. `null` values mean "no constraint". m2_min is inclusive, m2_max is
// exclusive — same convention as the bucket boundaries below.
export const SIZE_BUCKET_FILTERS = {
  '1-mono':   { rooms_eq: 1, m2_min: null, m2_max: null },
  '2-chico':  { rooms_eq: 2, m2_min: null, m2_max: 50 },
  '2-normal': { rooms_eq: 2, m2_min: 50, m2_max: 70 },
  '2-grande': { rooms_eq: 2, m2_min: 70, m2_max: null },
  '3-chico':  { rooms_eq: 3, m2_min: null, m2_max: 70 },
  '3-normal': { rooms_eq: 3, m2_min: 70, m2_max: 90 },
  '3-grande': { rooms_eq: 3, m2_min: 90, m2_max: null },
  '4+':       { rooms_gte: 4, m2_min: null, m2_max: null },
  'ph-casa':  { property_type_in: ['ph', 'casa'], m2_min: null, m2_max: null },
};

// Classify a listing by (rooms, homogenized_m2, property_type). Returns one
// of the keys in SIZE_BUCKETS, or `null` when there isn't enough info to
// classify (typically: missing rooms AND missing m²).
export function sizeBucket(rooms, m2, propertyType) {
  const pt = String(propertyType || '').toLowerCase();
  if (pt === 'ph' || pt === 'casa') return 'ph-casa';
  if (rooms == null) return null;
  if (rooms <= 1) return '1-mono';
  if (rooms >= 4) return '4+';
  // For 2 and 3 amb we need m² to decide chico/normal/grande. Without m²,
  // assume "normal" — it's the middle of the distribution and avoids dropping
  // the listing entirely. (Most listings have homogenized_m2 set; this is the
  // rare case.)
  const m2num = Number(m2);
  if (!Number.isFinite(m2num) || m2num <= 0) {
    return rooms === 2 ? '2-normal' : '3-normal';
  }
  if (rooms === 2) {
    if (m2num < 50) return '2-chico';
    if (m2num < 70) return '2-normal';
    return '2-grande';
  }
  if (rooms === 3) {
    if (m2num < 70) return '3-chico';
    if (m2num < 90) return '3-normal';
    return '3-grande';
  }
  return null;
}

// Secondary cross-rooms reference. For "2-grande" (a 2 amb >70 m²), people
// often compare it against "3-chico" (a 3 amb <70 m²) — overlapping
// surfaces, different typology. Returns the bucket id we should peek at as a
// sanity-check reference, or `null` when there's no obvious neighbor.
export function crossRoomsReference(bucket) {
  switch (bucket) {
    case '2-grande': return '3-chico';   // overlapping 70-100m²
    case '3-chico':  return '2-grande';
    case '3-grande': return '4+';        // very large 3 amb ≈ small 4+
    case '4+':       return '3-grande';
    case '2-chico':  return '1-mono';    // small 2 amb ≈ generous mono
    case '1-mono':   return '2-chico';
    default:         return null;
  }
}
