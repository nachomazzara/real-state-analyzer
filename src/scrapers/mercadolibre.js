import { newContext } from '../browser.js';
import { logger } from '../logger.js';
import { sleep, jitter, safeNumber } from './base.js';

// MercadoLibre Inmuebles is a JS-rendered SPA. The HTML returned without JS
// execution is a sub-10 KB micro-landing; the listings only appear after the
// client bundle hydrates. We use Playwright with `networkidle` + an explicit
// selector wait to grab the real listings page.

const PAGE_SIZE = 48; // ML default

// ML's search returns at most ~1000 results per ordering. To cover more
// inventory in dense neighborhoods we iterate multiple orderings and
// deduplicate by external_id at the persist layer (UNIQUE(source, external_id)).
// The four orderings below give the best coverage diversity empirically:
// - default (ML's relevance algorithm)
// - price asc / price desc (separates cheap-end from premium tail)
// - newest first (catches recent listings the relevance algorithm hasn't
//   yet ranked)
const ORDERS = [
  { id: 'default', suffix: '' },
  { id: 'price_asc', suffix: '_OrderId_PRICE' },
  { id: 'price_desc', suffix: '_OrderId_PRICE*DESC' },
  { id: 'newest', suffix: '_OrderId_BEGIN*DESC' },
];

function buildUrl(neighborhood, operation, offset, orderSuffix = '') {
  const op = operation === 'venta' ? 'venta' : 'alquiler';
  const slug = neighborhood.id;
  const base = `https://listado.mercadolibre.com.ar/inmuebles/departamentos/${op}/capital-federal/${slug}/`;
  // ML's URL DSL: `/_Desde_N_OrderId_X_NoIndex_True` — segments can be
  // chained in any order, just need to keep the trailing `_NoIndex_True`.
  const desde = offset > 0 ? `_Desde_${offset + 1}` : '';
  return `${base}${desde}${orderSuffix}_NoIndex_True`;
}

function extractIdFromUrl(url) {
  if (!url) return null;
  // Permalink ends with MLA-12345678-... or contains MLA1234567890.
  const m = url.match(/MLA-?(\d{6,12})/);
  return m ? `MLA${m[1]}` : null;
}

// Each card has standardized andes-* classes. We parse from the page DOM via
// page.$$eval so the work happens inside the browser (faster + less ferrying
// large HTML across the bridge).
async function parseCards(page) {
  return await page.$$eval('li.ui-search-layout__item, div.ui-search-result__wrapper', (nodes) => {
    function text(el, sel) {
      const n = el.querySelector(sel);
      return n ? (n.textContent || '').trim() : null;
    }
    const out = [];
    for (const card of nodes) {
      const linkEl = card.querySelector('a.ui-search-link, a.poly-component__title, a[href*="MLA"]');
      const url = linkEl ? linkEl.href : null;
      if (!url) continue;

      const priceFraction = text(card, '.andes-money-amount__fraction');
      const priceDecimals = text(card, '.andes-money-amount__cents');
      const currencySymbol = text(card, '.andes-money-amount__currency-symbol');

      // Attribute strings: "Monoambiente · 30 m²", "2 ambientes · 1 dormitorio · 1 baño · 45 m² totales"
      const attrItems = [...card.querySelectorAll('.poly-component__attributes-list li, .ui-search-card-attributes__attribute, .ui-search-item__group__element')]
        .map((n) => n.textContent.trim());
      const attrBlob = attrItems.join(' · ').toLowerCase();
      const titleText = text(card, '.poly-component__title, .ui-search-item__title');
      const locationText = text(card, '.poly-component__location, .ui-search-item__location');
      const descText = text(card, '.poly-component__headline, .ui-search-item__group__element--highlighted') || '';

      out.push({
        url,
        priceFraction,
        priceDecimals,
        currencySymbol,
        attrBlob,
        attrItems,
        title: titleText,
        location: locationText,
        description: descText,
      });
    }
    return out;
  });
}

function toListing(raw, neighborhood, operation) {
  const external_id = extractIdFromUrl(raw.url);
  if (!external_id) return null;

  // Price: combine fraction + decimals.
  let priceText = (raw.priceFraction || '').replace(/[^\d.,]/g, '');
  if (raw.priceDecimals) priceText += ',' + String(raw.priceDecimals).replace(/[^\d]/g, '');
  const price = safeNumber(priceText);
  let currency = null;
  const cs = (raw.currencySymbol || '').toUpperCase();
  if (cs.includes('US$') || cs === 'USD' || cs === 'U$S') currency = 'USD';
  else if (cs === '$' || cs.startsWith('$')) currency = 'ARS';

  // ML leaks alquiler listings into the venta search bucket and vice-versa.
  // We can't disambiguate at card-parse time — the card HTML is identical
  // for both operations (no "/mes" or "Por mes" suffix in the price block,
  // verified empirically). The enricher fixes the operation later by reading
  // the detail-page breadcrumb ("Inmuebles > Departamentos > Alquiler|Venta").

  const blob = raw.attrBlob || '';

  const roomsMatch = blob.match(/(\d+)\s*ambient/);
  let rooms = roomsMatch ? Number(roomsMatch[1]) : null;
  if (rooms == null && /monoambiente/.test(blob)) rooms = 1;
  if (rooms == null && raw.url) {
    // ML permalinks encode rooms as "N-amb" or "monoambiente".
    const slugMatch = raw.url.match(/[-/](\d{1,2})-amb\b/i);
    if (slugMatch) rooms = Number(slugMatch[1]);
    else if (/monoambiente/i.test(raw.url)) rooms = 1;
  }

  const bedroomsMatch = blob.match(/(\d+)\s*dormitor/);
  const bedrooms = bedroomsMatch ? Number(bedroomsMatch[1]) : null;

  const bathroomsMatch = blob.match(/(\d+)\s*baño/);
  const bathrooms = bathroomsMatch ? Number(bathroomsMatch[1]) : null;

  const coveredMatch = blob.match(/([\d.,]+)\s*m²?\s*cubie?/);
  const covered_m2 = coveredMatch ? safeNumber(coveredMatch[1]) : null;
  const totalMatch = blob.match(/([\d.,]+)\s*m²?\s*totale?/);
  const total_m2 = totalMatch ? safeNumber(totalMatch[1]) : null;

  const ageBlob = ((raw.title || '') + ' ' + (raw.description || '')).toLowerCase();
  let age_years = null;
  if (/a\s*estrenar|estreno|nuevo a estrenar/.test(ageBlob)) age_years = 0;
  else {
    const ageMatch = ageBlob.match(/(\d+)\s*años?\s+de\s+antig/);
    if (ageMatch) age_years = Number(ageMatch[1]);
  }

  // Amenity detection: combine title + description + the structured
  // attribute blob ("3 ambientes · 1 cochera · 65 m²"). The card's
  // "1 cochera" lives in attrBlob, not in the description — checking only
  // description misses the majority of garage signals.
  const amenityBlob = ((raw.title || '') + ' ' + (raw.description || '') + ' ' + (raw.attrBlob || '')).toLowerCase();
  // Exclude false positives like "pileta de acero inoxidable" (kitchen sink).
  const has_pool = /(?:^|[^a-záéíóúñ])piscina|(?:^|[^a-záéíóúñ])pileta(?!\s+de\s+(?:acero|cocina|granito|servicio|lavar|lavadero|lavarropas|inox))/i.test(amenityBlob);
  const has_garage = /\bcochera|\bgarage|\bgaraje|estacionamiento/.test(amenityBlob);
  const has_amenities = /amenit|gimnasio|laundry|seguridad|\bsum\b/.test(amenityBlob);

  // Floor.
  let floor = null;
  const m1 = ((raw.title || '') + ' ' + (raw.description || '')).match(/\bpiso\s*[nº°#:]?\s*(\d{1,3})\b/i);
  if (m1) floor = m1[1];
  else if (/\bplanta\s+baja\b|\bP\.?B\.?\b/i.test(raw.title || raw.description || '')) floor = 'PB';

  return {
    source: 'mercadolibre',
    external_id,
    url: raw.url,
    operation,
    city: null,
    neighborhood: neighborhood.id,
    neighborhood_raw: raw.location || neighborhood.display,
    property_type: 'departamento',
    rooms,
    bedrooms,
    bathrooms,
    covered_m2,
    uncovered_m2:
      Number.isFinite(total_m2) && Number.isFinite(covered_m2) && total_m2 > covered_m2
        ? total_m2 - covered_m2
        : null,
    total_m2,
    age_years,
    has_pool,
    has_amenities,
    has_garage,
    floor,
    amenities: [
      ...(has_pool ? ['pileta'] : []),
      ...(has_garage ? ['cochera'] : []),
    ],
    price,
    currency,
    description: ((raw.title || '') + ' ' + (raw.description || '')).slice(0, 1500),
    raw: { title: raw.title, location: raw.location, attrItems: raw.attrItems },
  };
}

async function fetchPage(neighborhood, operation, offset, orderSuffix = '') {
  const url = buildUrl(neighborhood, operation, offset, orderSuffix);
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    // `networkidle` waits forever on ML's heavy listings page. domcontentloaded
    // + an explicit selector wait is both faster and more reliable.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const finalUrl = page.url();
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    const authFail = detectAuthFailure(finalUrl, text);
    if (authFail) {
      throw new MercadoLibreAuthError(`${authFail} — cookies likely expired, refresh data/ml-cookies.txt`);
    }
    await page
      .waitForSelector(
        'li.ui-search-layout__item, .ui-search-rescue, .ui-search-zrp__title',
        { timeout: 20_000 },
      )
      .catch(() => null);
    return await parseCards(page);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Custom error so the orchestrator can react when ML throws an anti-bot wall.
export class MercadoLibreBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MercadoLibreBlockedError';
  }
}

// Thrown when ML signals the session is logged out / cookies are invalid.
// This is unrecoverable without a manual cookie refresh (data/ml-cookies.txt),
// so the orchestrator must stop hitting ML for the rest of the run instead of
// retrying every listing 3 times and burning hours producing nothing.
export class MercadoLibreAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MercadoLibreAuthError';
  }
}

// Centralized auth-state detection. Runs after a navigation completed: checks
// both the final URL (login/registration redirects) and the rendered text
// (ML's "Ingresá a tu cuenta para continuar" prompts). Returns null if the
// session looks fine, or an error message if auth is broken.
function detectAuthFailure(finalUrl, text) {
  if (/\/(jms\/mla\/lgz\/)?login|auth\.mercadolibre|\/registration|\/hub\/registration/i.test(finalUrl)) {
    return `auth redirect to ${finalUrl}`;
  }
  if (text && /ingres[áa]\s+a\s+tu\s+cuenta|necesit[áa]s?\s+iniciar\s+sesi[óo]n|tu\s+sesi[óo]n\s+expir[óo]/i.test(text)) {
    return 'page demands login';
  }
  return null;
}

// Visit one MercadoLibre listing's detail page and pull the structured
// "Principales" feature table. The values are rendered as LABEL\nVALUE inside
// `document.body.innerText`, so we extract by line-pairs after JS hydration.
export async function enrichDetail(url) {
  const ctx = await newContext();
  // Lingering close: on success keep the tab open 10-15s before closing, to
  // mimic a human glancing at the listing. On failure close immediately.
  let extractedOk = false;
  try {
    // Reset ML cookies to the known-good set from ml-cookies.txt before EVERY
    // detail navigation. ML's first response sets bot-detection cookies that
    // taint the session — subsequent requests get walled. Same pattern we use
    // for zonaprop. Each request starts with a clean, authenticated session.
    const { refreshMlCookies } = await import('../browser.js');
    await refreshMlCookies(ctx._underlying);
    const page = await ctx.newPage();
    // `commit` fires as soon as ML's first HTTP response arrives (~1s on a
    // healthy session). `domcontentloaded` is unreliable here — ML streams
    // the Polycard layout progressively and DCL can be delayed by minutes
    // behind their anti-fraud JS. We poll body.innerText below to know when
    // the structured fields have rendered, instead of waiting on the event.
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: 20_000 });
    if (resp && (resp.status() === 404 || resp.status() === 410)) {
      const { ListingGoneError } = await import('./base.js');
      throw new ListingGoneError(`http ${resp.status()}`, resp.status());
    }
    const finalUrl = page.url();
    const authFailUrl = detectAuthFailure(finalUrl, '');
    if (authFailUrl) {
      throw new MercadoLibreAuthError(`${authFailUrl} — cookies likely expired, refresh data/ml-cookies.txt`);
    }
    if (
      /\/gz\/|account-verification|\/captcha/i.test(finalUrl) ||
      /\/gz\//i.test(url) === false && finalUrl !== url && !finalUrl.includes('MLA-')
    ) {
      throw new MercadoLibreBlockedError(`anti-bot redirect to ${finalUrl}`);
    }
    // Poll body.innerText every 200ms until either the structured markers
    // we'll parse are visible, or 10s elapses. Bailing as soon as the data
    // is there saves several seconds per listing vs. waiting on a static
    // selector that breaks when ML tweaks classnames.
    const READY_RE = /superficie\s+(total|cubierta)|m²\s+totales?|\bambientes?\b|antig[üu]edad/i;
    let text = '';
    const readyDeadline = Date.now() + 10_000;
    while (Date.now() < readyDeadline) {
      text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      if (text && READY_RE.test(text)) break;
      await page.waitForTimeout(200);
    }
    // Fallback: click "Ver todas las características" if the markers never
    // showed up (some listings hide them behind that toggle).
    if (!text || !READY_RE.test(text)) {
      try {
        const btn = page.locator('button:has-text("Ver todas")').first();
        if (await btn.count()) {
          await btn.click({ timeout: 1_000 }).catch(() => {});
          await page.waitForTimeout(400);
          text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        }
      } catch { /* ignore */ }
    }
    if (!text) return null;
    const authFailText = detectAuthFailure(finalUrl, text);
    if (authFailText) {
      throw new MercadoLibreAuthError(`${authFailText} — cookies likely expired, refresh data/ml-cookies.txt`);
    }
    // Listings whose publisher closed them ("Publicación finalizada" or
    // "Publicación pausada") still respond 200 with a simplified detail page.
    // Our DB still has them active=1 from the last scrape. Mark them gone so
    // they fall out of the pending pool — re-fetching them is pointless.
    if (/publicaci[oó]n\s+(finalizada|pausada|cancelada)/i.test(text)) {
      const { ListingGoneError } = await import('./base.js');
      throw new ListingGoneError('listing closed (Publicación finalizada/pausada)');
    }
    // Breadcrumb is authoritative for venta vs alquiler. ML's detail page
    // renders "Inmuebles > Departamentos > Alquiler|Venta > Capital Federal
    // > ... > <barrio>". When ML leaks an alquiler into the venta search
    // bucket (or vice-versa), the breadcrumb still shows the correct one.
    let detectedOperation = null;
    const breadcrumbMatch = text.match(/inmuebles\s*[›>]\s*[^>]+\s*[›>]\s*(alquiler|venta)\b/i);
    if (breadcrumbMatch) {
      detectedOperation = breadcrumbMatch[1].toLowerCase();
    }
    const lines = text.split('\n').map((l) => l.trim());
    // Walk pairs: a label followed by its value on the next line. Take the
    // FIRST occurrence of each label so a later section header with the same
    // word doesn't override it (e.g. "Ambientes" section header).
    const seen = {};
    for (let i = 0; i < lines.length - 1; i++) {
      const label = lines[i];
      const value = lines[i + 1];
      if (!label || !value) continue;
      const key = label.toLowerCase();
      if (seen[key] != null) continue;
      seen[key] = value;
    }
    function num(v) {
      if (v == null) return null;
      const m = String(v).match(/[\d.,]+/);
      if (!m) return null;
      let s = m[0];
      if (s.includes('.') && !s.includes(',')) {
        const parts = s.split('.');
        if (parts.slice(1).every((p) => p.length === 3)) s = s.replace(/\./g, '');
      } else if (s.includes(',') && !s.includes('.')) {
        s = s.replace(',', '.');
      } else if (s.includes('.') && s.includes(',')) {
        s = s.replace(/\./g, '').replace(',', '.');
      }
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    const out = {};
    let total = num(seen['superficie total']);
    let cub = num(seen['superficie cubierta']);
    const balc = num(seen['superficie de balcón']);
    let amb = num(seen['ambientes']);
    const dorm = num(seen['dormitorios']);
    const ban = num(seen['baños']);
    let coch = num(seen['cocheras']);
    let ant = num(seen['antigüedad']);
    const piso = seen['número de piso de la unidad'];
    // Fallback: some ML pages (especially finalized/paused listings, or new
    // page layouts) skip the LABEL\nVALUE table and only show a compact
    // header like "44 m² totales · 2 ambientes · Antigüedad 21 años". Scan
    // the body text for those patterns when the labeled lookups missed.
    if (!total) {
      const m = text.match(/([\d.,]+)\s*m²?\s*totales?/i);
      if (m) total = num(m[1]);
    }
    if (!cub) {
      const m = text.match(/([\d.,]+)\s*m²?\s*cubiert/i);
      if (m) cub = num(m[1]);
    }
    if (!amb) {
      const m = text.match(/(\d+)\s+ambientes?/i);
      if (m) amb = Number(m[1]);
    }
    // ML's label/value pair-walker misses "Cocheras: 0" when label and value
    // share a line. Without this the seller's explicit "0 cocheras" gets lost
    // and enrich.js falls back to body-text detection (which sees "cochera"
    // in amenity copy and flips the flag to 1). Use == null so a real 0 from
    // the pair-walker isn't overwritten.
    if (coch == null) {
      const m = text.match(/\bcocheras?\s*[:\s]\s*(\d+)\b/i);
      if (m) coch = Number(m[1]);
    }
    if (ant == null) {
      // Look for "Antigüedad" near a number — must be the structured label,
      // not just any mention. The label/value pair often gets concatenated
      // into "Antigüedad 21 años" when ML's layout doesn't put them on
      // separate lines.
      const m = text.match(/antig[uü]edad\s*[:\s]\s*(\d+)\s*años?/i);
      if (m) ant = Number(m[1]);
      else {
        // "A estrenar" ONLY counts when it's adjacent to the "Antigüedad"
        // label (structured field), not as a free-floating mention anywhere
        // on the page (it appears in footers, related-ads, descriptions of
        // other listings, etc — would falsely flag every listing as new).
        const labelAdjacent = text.match(/antig[uü]edad\s*[:\s]?\s*a\s*estrenar/i);
        if (labelAdjacent) ant = 0;
      }
    }
    // Areas must be positive — a "0 m²" is the parser misreading a missing
    // value, not a real measurement.
    if (Number.isFinite(total) && total > 0) out.total_m2 = total;
    if (Number.isFinite(cub) && cub > 0) out.covered_m2 = cub;
    if (Number.isFinite(balc) && balc > 0) out.uncovered_m2 = balc;
    if (Number.isFinite(amb)) out.rooms = amb;
    if (Number.isFinite(dorm)) out.bedrooms = dorm;
    if (Number.isFinite(ban)) out.bathrooms = ban;
    if (Number.isFinite(coch)) out.parking = coch;
    if (Number.isFinite(ant)) out.age_years = ant;
    if (piso) out.floor = String(piso).match(/\d+|pb/i)?.[0] || null;
    if (text) out.description = text.slice(0, 6000);
    if (detectedOperation) out.operation = detectedOperation;
    // Address — ML's detail page shows the canonical address in two places:
    //   1) Subtitle right below the title (e.g. "Av. Cabildo 4667 4° C, Capital Federal")
    //   2) "Ubicación e información de la zona" section with the full
    //      "STREET ALTURA [4° C], BARRIO, Capital Federal" line.
    // The detail-page address is way more reliable than the card's
    // `neighborhood_raw` (which sellers sometimes pollute with title text).
    // We prefer the "Ubicación" line when present because it includes the
    // barrio; fall back to a generic "..., Capital Federal" match.
    let mlAddress = null;
    const ubMatch = text.match(/Ubicaci[oó]n\s+e\s+informaci[oó]n\s+de\s+la\s+zona[\s\S]{0,200}?\n+\s*([^\n]+?,\s*[^\n]+?,\s*Capital Federal)\b/i);
    if (ubMatch) {
      mlAddress = ubMatch[1].replace(/\s*,\s*Capital Federal\s*,\s*Capital Federal\s*$/i, ', Capital Federal').trim();
    }
    if (!mlAddress) {
      // Fallback: any "STREET ALTURA, BARRIO, Capital Federal" line. Strict
      // pattern (starts with a capital, has a number, ends with ", Capital
      // Federal") so we don't grab fragments from descriptions.
      const lineMatch = text.match(/^[ \t]*([A-ZÁÉÍÓÚÑ][^\n,]{2,60}\s+\d{2,5}(?:\s+\d+°?\s*[A-Z]?)?,\s*[^\n,]+,\s*Capital Federal)\s*$/m);
      if (lineMatch) mlAddress = lineMatch[1].trim();
    }
    if (mlAddress) out.address = mlAddress;
    extractedOk = true;
    return out;
  } finally {
    if (extractedOk) {
      // Lingering close: keep the tab open 10-15s before closing. Doesn't
      // block the caller (setTimeout not awaited) — the listing data returns
      // immediately, the tab close just happens later in the background.
      const linger = 10_000 + Math.random() * 5_000;
      setTimeout(() => { ctx.close().catch(() => {}); }, linger);
    } else {
      await ctx.close().catch(() => {});
    }
  }
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ML's location URL doesn't reliably filter by neighborhood — we see
// Microcentro, Boedo, Nordelta listings when we asked for Saavedra. Drop
// anything whose slug/text doesn't mention the requested neighborhood.
function neighborhoodMatches(listing, neighborhood) {
  const wanted = [neighborhood.id, ...(neighborhood.aliases || [])]
    .map(normalizeText)
    .filter(Boolean);
  const hay = [listing.url, listing.neighborhood_raw, listing.description]
    .filter(Boolean)
    .map(normalizeText)
    .join(' | ');
  return wanted.some((t) => hay.includes(t));
}

// Detect listings whose URL contradicts the operation we asked for. ML
// frequently leaks listings between operation buckets, and a sale price
// stored as a "rental" of US$ 135.000/mes destroys our medians.
function operationMatchesUrl(listing, operation) {
  const u = String(listing.url || '').toLowerCase();
  if (operation === 'alquiler') {
    // Any `-venta-` segment anywhere in the slug means it's a SALE listing
    // miscategorized as rental. Old regex required `venta` immediately after
    // the ID; real URLs have `2626827622-saavedra-venta-2-ambientes...`.
    if (/[-_/]venta[-_/]/.test(u)) return false;
    if (/[-_/]en-venta[-_/]/.test(u)) return false;
    // Sale-listing keywords that signal pollution: "inversion-con-renta",
    // "alquilerventa" (combo listings), "renta-activa" / "renta inmediata".
    if (/\binversion[-_]con[-_]renta\b/.test(u)) return false;
    if (/\balquilerventa\b|\bventa[-_]alquiler\b/.test(u)) return false;
    if (/[-_/]renta[-_/]activa[-_/]/.test(u)) return false;
  }
  if (operation === 'venta') {
    if (/[-_/]alquiler[-_/]/.test(u)) return false;
    if (/[-_/]en[-_]alquiler[-_/]/.test(u)) return false;
    if (/[-_/]renta[-_/]inmediata[-_/]/.test(u)) return false;
  }
  return true;
}

export async function* iterateListings(neighborhood, operation, _opts = {}) {
  // ML caps its search at offset ~1000 per ordering. To cover the long tail
  // we iterate the same neighborhood under 4 orderings (default, price asc,
  // price desc, newest). The DB's UNIQUE(source, external_id) constraint
  // deduplicates rows that appear in more than one ordering, so the net
  // effect is "1000 per ordering, deduped — typically 1500-3000 unique
  // listings for dense neighborhoods like Núñez".
  const seenIds = new Set();
  for (const order of ORDERS) {
    let offset = 0;
    let emptyPages = 0;
    while (offset < 1000) {
      let raws;
      try {
        raws = await fetchPage(neighborhood, operation, offset, order.suffix);
      } catch (err) {
        // Auth errors are unrecoverable without a manual cookie refresh —
        // propagate so the orchestrator stops the entire ML scrape instead of
        // walking through every ordering producing nothing.
        if (err.name === 'MercadoLibreAuthError') throw err;
        logger.warn(
          { err: err.message, offset, order: order.id, neighborhood: neighborhood.id },
          'mercadolibre fetch failed',
        );
        // Don't abort the whole multi-order pass; move on to the next order.
        break;
      }
      const all = raws.map((r) => toListing(r, neighborhood, operation)).filter(Boolean);
      let droppedOp = 0;
      let droppedNb = 0;
      let droppedDup = 0;
      const listings = [];
      for (const l of all) {
        if (!operationMatchesUrl(l, operation)) { droppedOp++; continue; }
        if (!neighborhoodMatches(l, neighborhood)) { droppedNb++; continue; }
        if (seenIds.has(l.external_id)) { droppedDup++; continue; }
        seenIds.add(l.external_id);
        listings.push(l);
      }
      if (droppedOp + droppedNb + droppedDup > 0) {
        logger.info(
          {
            neighborhood: neighborhood.id, operation, order: order.id,
            dropped_op: droppedOp, dropped_nb: droppedNb, dropped_dup: droppedDup,
            kept: listings.length,
          },
          'mercadolibre: filtered + deduped listings',
        );
      }
      if (all.length === 0) {
        emptyPages++;
        if (emptyPages >= 2) break;
      } else {
        emptyPages = 0;
      }
      // If this page brought 0 new IDs (everything was a dupe of what we
      // already saw across orderings) we're past the end of this ordering's
      // useful inventory — jump to the next ordering. Note: within ONE
      // ordering ML usually paginates strictly without repeats, so this only
      // fires near the offset-1000 cap or when an ordering overlaps a
      // previous one entirely.
      if (listings.length === 0 && all.length > 0) {
        logger.info(
          { offset, order: order.id, neighborhood: neighborhood.id },
          'mercadolibre: no new listings in this page — moving to next ordering',
        );
        break;
      }
      yield { page: Math.floor(offset / PAGE_SIZE) + 1, listings, totalHint: null };
      offset += PAGE_SIZE;
      await sleep(jitter(800, 2200));
    }
  }
}
