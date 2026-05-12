const POZO_RE = /\b(en pozo|en pre[\s-]?venta|pre[\s-]?venta|al pozo|venta de pozo|fideicomiso)\b/i;
const CONSTRUCTION_RE = /\b(en construcc(?:i[oó]n)?|en obra|en desarrollo|future delivery|en pre[\s-]?obra)\b/i;
const ENTREGA_HINT_RE = /\b(entrega|posesi[oó]n|fin\s+de\s+obra|finalizaci[oó]n)\b/i;
// Word "proyecto" alone is a strong signal of an off-plan development. The
// financed-sale detection (anticipo + cuotas) lives in normalize.js because
// it has to be cross-checked against the card price.
const PROYECTO_RE = /\bproyecto\b/i;

const SPANISH_MONTHS = {
  enero: 1, ene: 1, jan: 1, january: 1,
  febrero: 2, feb: 2, february: 2,
  marzo: 3, mar: 3, march: 3,
  abril: 4, abr: 4, apr: 4, april: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6, june: 6,
  julio: 7, jul: 7, july: 7,
  agosto: 8, ago: 8, aug: 8, august: 8,
  septiembre: 9, setiembre: 9, sept: 9, sep: 9, september: 9,
  octubre: 10, oct: 10, october: 10,
  noviembre: 11, nov: 11, november: 11,
  diciembre: 12, dic: 12, dec: 12, december: 12,
};

// When a listing is sold with financing ("ANTICIPO USS 55.900 + 18 CUOTAS
// FIJAS EN USS de USS 7.243"), the card price field usually shows only the
// anticipo. The full sale price is anticipo + N × cuota. This parses the
// pattern and returns { totalPrice, currency } when both components are
// extractable; otherwise null.
export function parseFinancedPrice(text) {
  if (!text) return null;
  const s = String(text);
  // Anticipo amount. The non-digit gap stops at newline only (not period)
  // because amounts use dot as thousand separator ("55.900").
  const anticipoMatch = s.match(/anticipo[^\d\n]{0,30}(?:uss?|u\$s?|usd|us\$)?\s*\$?\s*([\d.,]+)/i);
  if (!anticipoMatch) return null;
  // Cuotas: number AND amount. Patterns we see:
  //   "18 CUOTAS FIJAS EN USS de USS 7.243"
  //   "24 cuotas de USD 5.000"
  //   "cuotas de 24 x USS 5.000"
  let nCuotas = null;
  let cuotaAmount = null;
  let m = s.match(/(\d{1,3})\s*cuotas?[^\n]{0,80}?(?:uss?|u\$s?|usd|us\$|de)\s*\$?\s*([\d.,]+)/i);
  if (m) {
    nCuotas = Number(m[1]);
    cuotaAmount = parseAmount(m[2]);
  } else {
    m = s.match(/cuotas?\s*de\s*(\d{1,3})\s*[x×]\s*(?:uss?|u\$s?|usd|us\$)?\s*\$?\s*([\d.,]+)/i);
    if (m) {
      nCuotas = Number(m[1]);
      cuotaAmount = parseAmount(m[2]);
    }
  }
  if (nCuotas == null || cuotaAmount == null || nCuotas <= 0 || cuotaAmount <= 0) return null;
  const anticipo = parseAmount(anticipoMatch[1]);
  if (anticipo == null || anticipo <= 0) return null;
  const currency = /uss?|u\$s?|usd|us\$/i.test(s) ? 'USD' : 'ARS';
  return {
    totalPrice: anticipo + nCuotas * cuotaAmount,
    anticipo,
    nCuotas,
    cuotaAmount,
    currency,
  };
}

function parseAmount(s) {
  if (s == null) return null;
  let str = String(s).trim();
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

// Parse the soonest reasonable delivery date out of free text.
// Returns { year, month } where month is 1-12, or null.
export function parseDeliveryDate(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  // Anchor on a delivery-keyword OR "a estrenar" so phrases like
  // "a estrenar — septiembre 2026" are parsed even without "entrega".
  // Random years elsewhere (publication date, address numbers) don't trip
  // the parser because we cap the search window after the keyword.
  const hintMatch = s.match(
    /(entrega|posesi[oó]n|fin\s+de\s+obra|finalizaci[oó]n|entrega\s+estimada|a\s+estrenar)[^.\n]{0,120}/i,
  );
  const scope = hintMatch ? hintMatch[0] : null;
  if (!scope) return null;

  // 1) "Septiembre 2026", "sep 2026", "septiembre/2026"
  const monthNames = Object.keys(SPANISH_MONTHS).join('|');
  let m = scope.match(new RegExp(`\\b(${monthNames})\\b[\\s/\\-,]*?(\\d{4})`, 'i'));
  if (m) return { month: SPANISH_MONTHS[m[1].toLowerCase()], year: Number(m[2]) };

  // 2) "06/2026", "06-2026"
  m = scope.match(/\b(0?[1-9]|1[0-2])[\/\-](\d{4})\b/);
  if (m) return { month: Number(m[1]), year: Number(m[2]) };

  // 3) bare year: "Entrega 2027" — assume December (worst case for the user).
  m = scope.match(/\b(20\d{2})\b/);
  if (m) return { month: 12, year: Number(m[1]) };

  return null;
}

export function classifyStatus(listing, now = new Date()) {
  const blob = (
    (listing.description || '') +
    ' ' +
    (listing.amenities || []).join(' ') +
    ' ' +
    (listing.property_type || '')
  ).toLowerCase();

  // Pozo / preventa is always pozo regardless of date.
  if (POZO_RE.test(blob)) {
    const d = parseDeliveryDate(blob);
    return {
      status: 'en-pozo',
      delivery_year: d?.year ?? null,
      delivery_month: d?.month ?? null,
    };
  }

  // Explicit "en construcción" / "en obra".
  if (CONSTRUCTION_RE.test(blob)) {
    const d = parseDeliveryDate(blob);
    return {
      status: 'construccion',
      delivery_year: d?.year ?? null,
      delivery_month: d?.month ?? null,
    };
  }

  // Listings whose copy describes a "proyecto" are off-plan developments.
  // (The anticipo+cuotas detection lives in normalize.js so it can be
  // cross-checked against the card price.)
  if (PROYECTO_RE.test(blob)) {
    const d = parseDeliveryDate(blob);
    if (d) {
      const todayMonths = now.getFullYear() * 12 + (now.getMonth() + 1);
      const deliveryMonths = d.year * 12 + d.month;
      const status = deliveryMonths > todayMonths ? 'en-pozo' : 'construccion';
      return { status, delivery_year: d.year, delivery_month: d.month };
    }
    return { status: 'construccion', delivery_year: null, delivery_month: null };
  }

  // If only an "entrega"/"posesión" date is mentioned, decide by today's date.
  // Future delivery → construccion. Past delivery (already handed over) →
  // disponible. The user explicitly wanted "a estrenar Sep 2026" classified
  // as construccion when today < Sep 2026.
  if (ENTREGA_HINT_RE.test(blob)) {
    // First, short-circuit positive "ready now" phrasing.
    if (/\bentrega\s+(?:inmediata|ya|hoy)\b/i.test(blob)) {
      return { status: 'disponible', delivery_year: null, delivery_month: null };
    }
    const d = parseDeliveryDate(blob);
    if (d) {
      const todayMonths = now.getFullYear() * 12 + (now.getMonth() + 1);
      const deliveryMonths = d.year * 12 + d.month;
      if (deliveryMonths > todayMonths) {
        return { status: 'construccion', delivery_year: d.year, delivery_month: d.month };
      }
      return { status: 'disponible', delivery_year: d.year, delivery_month: d.month };
    }
    // Hint present but no date parseable. If the phrasing is forward-looking
    // ("entrega estimada", "entrega prevista", "para el año"), mark as
    // construccion; otherwise default to disponible to avoid false positives.
    if (/\bentrega\s+(?:estimada|prevista|programada|aprox)/i.test(blob) ||
        /\bpara\s+el\s+a[ñn]o\b/i.test(blob) ||
        /\bfin\s+de\s+obra\b/i.test(blob)) {
      return { status: 'construccion', delivery_year: null, delivery_month: null };
    }
    return { status: 'disponible', delivery_year: null, delivery_month: null };
  }

  return { status: 'disponible', delivery_year: null, delivery_month: null };
}
