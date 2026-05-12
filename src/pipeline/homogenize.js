// Convert nullable numeric input to a real number or null. Avoids the trap
// of `Number(null) === 0` masquerading as a valid measurement.
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function homogenize(listing) {
  const covered = num(listing.covered_m2);
  const uncovered = num(listing.uncovered_m2);
  const total = num(listing.total_m2);

  if (covered != null && uncovered != null) {
    return covered + uncovered * 0.5;
  }
  if (covered != null && total != null && total >= covered) {
    return covered + (total - covered) * 0.5;
  }
  if (covered != null) return covered;
  if (total != null) return total; // pessimistic: treat all as covered when we lack split
  return null;
}

// Mine ONLY explicit uncovered-area mentions (balcón, terraza, patio,
// descubiertos, semi-cubiertos) from free text. We deliberately do NOT try
// to extract `covered` or `total` from descriptions — those numbers tend to
// appear in marketing copy referencing the building (SUM, expensas, units
// in neighbouring lots) and conflating them with the unit's m² has caused
// gross errors (issue: a 48 m² unit was reported as 97 because the desc
// mentioned a 97 m² SUM). Trust only structured features from the scraper
// or the detail-page enrichment for covered/total.
//
// Returns { uncovered } if any addable area was found, otherwise {}.
export function mineAreasFromDescription(desc) {
  if (!desc) return {};
  const s = String(desc).toLowerCase();
  const out = {};

  let uncovered = 0;
  let foundUncovered = false;
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*(?:m²)?\s*descubiert[oa]s?/gi,
    /(\d+(?:[.,]\d+)?)\s*(?:m²)?\s*semi[\s-]?cubiert[oa]s?/gi,
    /balc[óo]n\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*m²?/gi,
    /(\d+(?:[.,]\d+)?)\s*m²?\s*de\s*balc[óo]n/gi,
    /terraza\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*m²?/gi,
    /(\d+(?:[.,]\d+)?)\s*m²?\s*de\s*terraza/gi,
    /patio\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*m²?/gi,
    /(\d+(?:[.,]\d+)?)\s*m²?\s*de\s*patio/gi,
  ];
  for (const re of patterns) {
    let mm;
    while ((mm = re.exec(s)) !== null) {
      const v = parseAmount(mm[1]);
      if (Number.isFinite(v) && v > 0 && v < 500) {
        uncovered += v;
        foundUncovered = true;
      }
    }
  }
  if (foundUncovered) out.uncovered = uncovered;

  return out;
}

function parseAmount(s) {
  if (s == null) return null;
  let str = String(s).trim();
  // Spanish locale: "1,5" → 1.5; "1.500" → 1500 (we deal with realistic m²
  // values, so any 3-digit group after a dot is treated as thousands).
  const hasDot = str.includes('.');
  const hasComma = str.includes(',');
  if (hasDot && !hasComma) {
    const parts = str.split('.');
    if (parts.slice(1).every((p) => p.length === 3)) str = str.replace(/\./g, '');
  } else if (hasComma && !hasDot) {
    str = str.replace(',', '.');
  } else if (hasDot && hasComma) {
    str = str.replace(/\./g, '').replace(',', '.');
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

export function ageBand(years) {
  if (years == null || !Number.isFinite(years)) return 'unknown';
  if (years <= 0) return 'a-estrenar';
  if (years < 5) return '0-5';
  if (years < 20) return '5-20';
  if (years < 50) return '20-50';
  return '50+';
}
