import Database from 'better-sqlite3';
import { config } from './config.js';
import { logger } from './logger.js';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  operation TEXT NOT NULL,
  city TEXT,
  neighborhood TEXT NOT NULL,
  neighborhood_raw TEXT,
  property_type TEXT,
  rooms INTEGER,
  bedrooms INTEGER,
  bathrooms INTEGER,
  covered_m2 REAL,
  uncovered_m2 REAL,
  total_m2 REAL,
  homogenized_m2 REAL,
  age_years INTEGER,
  age_band TEXT,
  has_pool INTEGER DEFAULT 0,
  has_amenities INTEGER DEFAULT 0,
  has_garage INTEGER DEFAULT 0,
  floor TEXT,
  amenities_json TEXT,
  price REAL,
  currency TEXT,
  price_usd REAL,
  status TEXT,
  delivery_year INTEGER,
  raw_json TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_neigh_op_seen ON listings(neighborhood, operation, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_neigh_rooms ON listings(neighborhood, rooms);
CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(active);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  price REAL,
  currency TEXT,
  price_usd REAL,
  FOREIGN KEY (listing_id) REFERENCES listings(id)
);
CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listing_id);

CREATE TABLE IF NOT EXISTS fx_rates (
  date TEXT PRIMARY KEY,
  mep_buy REAL,
  mep_sell REAL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  neighborhoods TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  counts_json TEXT,
  options_json TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS source_cursors (
  source TEXT NOT NULL,
  neighborhood TEXT NOT NULL,
  operation TEXT NOT NULL,
  last_full_scrape_at INTEGER,
  last_incremental_scrape_at INTEGER,
  last_known_total INTEGER,
  PRIMARY KEY (source, neighborhood, operation)
);

-- A saved search: neighborhoods + a frozen filter combo. Each unique combo is
-- one analysis with its own id; the page is rendered "in the context of" one
-- analysis so stats and ranking are computed under the same filters.
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL UNIQUE,
  neighborhoods_json TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_viewed_at INTEGER NOT NULL,
  last_scrape_job_id TEXT,
  view_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_analyses_last_viewed ON analyses(last_viewed_at DESC);

-- Sub-zones v2 (additive, feature-flagged): cache for address geocoding so we
-- only hit USIG/Nominatim once per unique street+altura.
CREATE TABLE IF NOT EXISTS geocode_cache (
  address_key TEXT PRIMARY KEY,
  lat REAL,
  lng REAL,
  source TEXT,
  normalized TEXT,
  geocoded_at INTEGER NOT NULL
);

-- Auto-derived cross-street labels for each H3 cell. Recomputable from the
-- listings table; cached for fast UI reads.
CREATE TABLE IF NOT EXISTS sub_zone_labels (
  sub_zone TEXT NOT NULL,
  neighborhood TEXT NOT NULL,
  label TEXT NOT NULL,
  listing_count INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (sub_zone, neighborhood)
);
CREATE INDEX IF NOT EXISTS idx_subzone_labels_neigh ON sub_zone_labels(neighborhood);
`;

export function getDb() {
  if (db) return db;
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  // Idempotent additive migrations for fields added after initial schema.
  const cols = db.prepare("PRAGMA table_info(listings)").all().map((r) => r.name);
  if (!cols.includes('floor')) {
    db.exec('ALTER TABLE listings ADD COLUMN floor TEXT');
  }
  if (!cols.includes('enrich_attempted_at')) {
    db.exec('ALTER TABLE listings ADD COLUMN enrich_attempted_at INTEGER');
  }
  if (!cols.includes('address')) {
    db.exec('ALTER TABLE listings ADD COLUMN address TEXT');
  }
  if (!cols.includes('address_normalized')) {
    db.exec('ALTER TABLE listings ADD COLUMN address_normalized TEXT');
  }
  if (!cols.includes('lat')) {
    db.exec('ALTER TABLE listings ADD COLUMN lat REAL');
  }
  if (!cols.includes('lng')) {
    db.exec('ALTER TABLE listings ADD COLUMN lng REAL');
  }
  if (!cols.includes('sub_zone')) {
    db.exec('ALTER TABLE listings ADD COLUMN sub_zone TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_listings_subzone ON listings(neighborhood, sub_zone)');
  }
  if (!cols.includes('geocode_failed_at')) {
    db.exec('ALTER TABLE listings ADD COLUMN geocode_failed_at INTEGER');
  }
  // sub_zone_labels PK changed from (sub_zone) → (sub_zone, neighborhood) so
  // the same H3 cell straddling two barrios doesn't overwrite its sibling's
  // label. The table is derived (regenerated by recomputeLabelsForNeighborhood)
  // so it's safe to drop and recreate when the legacy PK is detected.
  const subzonePk = db.prepare(`PRAGMA index_list('sub_zone_labels')`).all()
    .filter((i) => i.origin === 'pk');
  const subzonePkCols = subzonePk.length > 0
    ? db.prepare(`PRAGMA index_info('${subzonePk[0].name}')`).all().map((r) => r.name)
    : [];
  if (subzonePkCols.length === 1 && subzonePkCols[0] === 'sub_zone') {
    db.exec('DROP TABLE sub_zone_labels');
    db.exec(`CREATE TABLE sub_zone_labels (
      sub_zone TEXT NOT NULL,
      neighborhood TEXT NOT NULL,
      label TEXT NOT NULL,
      listing_count INTEGER NOT NULL,
      computed_at INTEGER NOT NULL,
      PRIMARY KEY (sub_zone, neighborhood)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_subzone_labels_neigh ON sub_zone_labels(neighborhood)');
  }
  // Any job left as "running" when the server starts is dead — its worker
  // was inside the previous Node process. Mark them failed so the UI can
  // recover and show a clean state instead of polling forever.
  const stale = db
    .prepare(
      `UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'`,
    )
    .run(Date.now(), JSON.stringify([{ message: 'server restarted before job completed' }]));
  if (stale.changes > 0) {
    logger.warn({ count: stale.changes }, 'marked stale running jobs as failed');
  }
  logger.info({ path: config.dbPath }, 'sqlite ready');
  return db;
}

export function isReady() {
  try {
    const d = getDb();
    d.prepare('SELECT 1').get();
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'db not ready');
    return false;
  }
}
