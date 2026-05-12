import { getDb } from '../db.js';

const SELECT_BY_EXT = `SELECT id, price, price_usd FROM listings WHERE source = ? AND external_id = ?`;
const UPDATE_FIELDS = `
UPDATE listings SET
  url = @url, operation = @operation, city = @city, neighborhood = @neighborhood,
  neighborhood_raw = @neighborhood_raw, property_type = @property_type,
  rooms = @rooms, bedrooms = @bedrooms, bathrooms = @bathrooms,
  covered_m2 = @covered_m2, uncovered_m2 = @uncovered_m2, total_m2 = @total_m2,
  homogenized_m2 = @homogenized_m2,
  age_years = @age_years, age_band = @age_band,
  has_pool = @has_pool, has_amenities = @has_amenities, has_garage = @has_garage,
  floor = @floor, amenities_json = @amenities_json,
  status = @status, delivery_year = @delivery_year, raw_json = @raw_json,
  last_seen_at = @now, active = 1
WHERE id = @id
`;
const INSERT = `
INSERT INTO listings (
  source, external_id, url, operation, city, neighborhood, neighborhood_raw, property_type,
  rooms, bedrooms, bathrooms, covered_m2, uncovered_m2, total_m2, homogenized_m2,
  age_years, age_band, has_pool, has_amenities, has_garage, floor, amenities_json,
  price, currency, price_usd, status, delivery_year, raw_json,
  first_seen_at, last_seen_at, last_updated_at, active
) VALUES (
  @source, @external_id, @url, @operation, @city, @neighborhood, @neighborhood_raw, @property_type,
  @rooms, @bedrooms, @bathrooms, @covered_m2, @uncovered_m2, @total_m2, @homogenized_m2,
  @age_years, @age_band, @has_pool, @has_amenities, @has_garage, @floor, @amenities_json,
  @price, @currency, @price_usd, @status, @delivery_year, @raw_json,
  @now, @now, @now, 1
)
`;
const UPDATE_PRICE = `
UPDATE listings SET
  price = ?, currency = ?, price_usd = ?,
  last_seen_at = ?, last_updated_at = ?, active = 1
WHERE id = ?
`;
const INSERT_HISTORY = `
INSERT INTO price_history (listing_id, observed_at, price, currency, price_usd)
VALUES (?, ?, ?, ?, ?)
`;

export function upsertListing(listing) {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare(SELECT_BY_EXT).get(listing.source, listing.external_id);

  if (!existing) {
    db.prepare(INSERT).run({ ...listing, now });
    return { state: 'new' };
  }

  const priceChanged =
    listing.price != null && existing.price != null && Math.abs(existing.price - listing.price) > 0.5;
  const usdChanged =
    listing.price_usd != null &&
    existing.price_usd != null &&
    Math.abs(existing.price_usd - listing.price_usd) > 0.5;

  if (priceChanged || usdChanged) {
    db.prepare(INSERT_HISTORY).run(
      existing.id,
      now,
      existing.price,
      listing.currency,
      existing.price_usd,
    );
    db.prepare(UPDATE_PRICE).run(listing.price, listing.currency, listing.price_usd, now, now, existing.id);
    // Also refresh the rest of the fields so parser fixes propagate.
    db.prepare(UPDATE_FIELDS).run({ ...listing, id: existing.id, now });
    return { state: 'updated', listingId: existing.id };
  }

  // Same price, but always refresh the other fields so corrections to the
  // scrapers (e.g. tightened has_garage detection) take effect on the next
  // scrape without requiring a DB wipe.
  db.prepare(UPDATE_FIELDS).run({ ...listing, id: existing.id, now });
  return { state: 'unchanged', listingId: existing.id };
}

export function getCursor(source, neighborhood, operation) {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM source_cursors WHERE source = ? AND neighborhood = ? AND operation = ?',
    )
    .get(source, neighborhood, operation);
}

export function upsertCursor({ source, neighborhood, operation, lastFullScrapeAt, lastIncrementalScrapeAt, lastKnownTotal }) {
  const db = getDb();
  const existing = getCursor(source, neighborhood, operation);
  if (existing) {
    db.prepare(
      `UPDATE source_cursors SET
        last_full_scrape_at = COALESCE(?, last_full_scrape_at),
        last_incremental_scrape_at = COALESCE(?, last_incremental_scrape_at),
        last_known_total = COALESCE(?, last_known_total)
      WHERE source = ? AND neighborhood = ? AND operation = ?`,
    ).run(
      lastFullScrapeAt ?? null,
      lastIncrementalScrapeAt ?? null,
      lastKnownTotal ?? null,
      source,
      neighborhood,
      operation,
    );
  } else {
    db.prepare(
      `INSERT INTO source_cursors (source, neighborhood, operation, last_full_scrape_at, last_incremental_scrape_at, last_known_total)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      source,
      neighborhood,
      operation,
      lastFullScrapeAt ?? null,
      lastIncrementalScrapeAt ?? null,
      lastKnownTotal ?? null,
    );
  }
}

export function markStaleInactive(source, neighborhood, operation, scrapeStartedAt) {
  const db = getDb();
  // Listings we did NOT touch in this scrape get deactivated.
  const res = db
    .prepare(
      `UPDATE listings SET active = 0
       WHERE source = ? AND neighborhood = ? AND operation = ? AND last_seen_at < ?`,
    )
    .run(source, neighborhood, operation, scrapeStartedAt);
  return res.changes;
}
