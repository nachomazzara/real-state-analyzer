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
