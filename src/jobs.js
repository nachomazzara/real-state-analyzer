import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { logger } from './logger.js';
import { scrapeNeighborhood, scrapeSingleTarget } from './pipeline/orchestrator.js';
import { enrichListingsForSource } from './pipeline/enrich.js';
import { readFileSync } from 'node:fs';
import { config } from './config.js';

const jobs = new Map();

function loadNeighborhoods() {
  const raw = readFileSync(config.neighborhoodsPath, 'utf8');
  return JSON.parse(raw).neighborhoods || [];
}

function findNeighborhood(idOrAlias) {
  const all = loadNeighborhoods();
  const needle = String(idOrAlias).toLowerCase();
  return all.find(
    (n) => n.id === needle || (n.aliases || []).some((a) => a.toLowerCase() === needle),
  );
}

export function createJob({ neighborhoods, options }) {
  const id = randomUUID();
  const startedAt = Date.now();
  const state = {
    id,
    neighborhoods,
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    options,
    progress: [],
    counts: {},
    errors: [],
  };
  jobs.set(id, state);

  const db = getDb();
  db.prepare(
    `INSERT INTO jobs (id, neighborhoods, status, started_at, options_json, counts_json)
     VALUES (?, ?, 'running', ?, ?, ?)`,
  ).run(id, neighborhoods.join(','), startedAt, JSON.stringify(options), '{}');

  // fire and forget
  runJob(state).catch((err) => logger.error({ err: err.message, jobId: id }, 'job runner crashed'));
  return state;
}

async function runJob(state) {
  const db = getDb();
  try {
    for (const slug of state.neighborhoods) {
      const found = findNeighborhood(slug);
      if (!found) {
        state.errors.push({ neighborhood: slug, error: 'unknown_neighborhood' });
        continue;
      }
      const results = await scrapeNeighborhood(found, {
        force: !!state.options?.force,
        onProgress: (p) => {
          state.progress.push({ ...p, at: Date.now() });
        },
      });
      state.counts[found.id] = results;
    }
    state.status = 'completed';
  } catch (err) {
    state.status = 'failed';
    state.errors.push({ message: err.message });
    logger.error({ err: err.message, jobId: state.id }, 'job failed');
  } finally {
    state.finished_at = Date.now();
    db.prepare(
      `UPDATE jobs SET status = ?, finished_at = ?, counts_json = ?, error = ? WHERE id = ?`,
    ).run(
      state.status,
      state.finished_at,
      JSON.stringify(state.counts),
      state.errors.length ? JSON.stringify(state.errors) : null,
      state.id,
    );
  }
}

export function getJob(id) {
  return jobs.get(id);
}

// Create an enrich-only job: re-process listings of (source, neighborhood)
// that still have null covered_m2, total_m2 or age_years. Skips the scrape
// phase entirely — much faster than a full refresh when the user only wants
// to fill in missing detail-page data.
export function createEnrichPendingJob({ source, neighborhood, force = false }) {
  const id = randomUUID();
  const startedAt = Date.now();
  const state = {
    id,
    neighborhoods: [neighborhood],
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    options: { enrich_only: true, source, force },
    progress: [],
    counts: {},
    errors: [],
  };
  jobs.set(id, state);
  const db = getDb();
  db.prepare(
    `INSERT INTO jobs (id, neighborhoods, status, started_at, options_json, counts_json)
     VALUES (?, ?, 'running', ?, ?, ?)`,
  ).run(id, neighborhood, startedAt, JSON.stringify(state.options), '{}');

  (async () => {
    try {
      const result = await enrichListingsForSource({
        source,
        neighborhood,
        force,
        onProgress: (p) => state.progress.push({ ...p, at: Date.now() }),
      });
      state.counts[neighborhood] = [{ source, ...result }];
      state.status = 'completed';
    } catch (err) {
      state.status = 'failed';
      state.errors.push({ message: err.message });
      logger.error({ err: err.message, jobId: state.id }, 'enrich-pending job crashed');
    } finally {
      state.finished_at = Date.now();
      db.prepare(
        `UPDATE jobs SET status = ?, finished_at = ?, counts_json = ?, error = ? WHERE id = ?`,
      ).run(
        state.status,
        state.finished_at,
        JSON.stringify(state.counts),
        state.errors.length ? JSON.stringify(state.errors) : null,
        state.id,
      );
    }
  })().catch((err) => logger.error({ err: err.message }, 'enrich-pending outer error'));

  return state;
}

// Create a job that refreshes a single (source, neighborhood, operation) tuple.
// Useful when one scraper failed and the user wants to retry just that one.
export function createTargetedJob({ source, neighborhood, operation, mode }) {
  const id = randomUUID();
  const startedAt = Date.now();
  const state = {
    id,
    neighborhoods: [neighborhood],
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    options: { targeted: true, source, operation, mode },
    progress: [],
    counts: {},
    errors: [],
  };
  jobs.set(id, state);

  const db = getDb();
  db.prepare(
    `INSERT INTO jobs (id, neighborhoods, status, started_at, options_json, counts_json)
     VALUES (?, ?, 'running', ?, ?, ?)`,
  ).run(id, neighborhood, startedAt, JSON.stringify(state.options), '{}');

  (async () => {
    try {
      const found = findNeighborhood(neighborhood);
      if (!found) {
        state.errors.push({ neighborhood, error: 'unknown_neighborhood' });
        state.status = 'failed';
        return;
      }
      const result = await scrapeSingleTarget({
        source,
        neighborhood: found,
        operation,
        mode,
        onProgress: (p) => state.progress.push({ ...p, at: Date.now() }),
      });
      state.counts[found.id] = [result];
      state.status = result.ok ? 'completed' : 'failed';
      if (!result.ok) state.errors.push({ source, operation, error: result.error });
    } catch (err) {
      state.status = 'failed';
      state.errors.push({ message: err.message });
      logger.error({ err: err.message, jobId: state.id }, 'targeted job crashed');
    } finally {
      state.finished_at = Date.now();
      db.prepare(
        `UPDATE jobs SET status = ?, finished_at = ?, counts_json = ?, error = ? WHERE id = ?`,
      ).run(
        state.status,
        state.finished_at,
        JSON.stringify(state.counts),
        state.errors.length ? JSON.stringify(state.errors) : null,
        state.id,
      );
    }
  })().catch((err) => logger.error({ err: err.message }, 'targeted job outer error'));

  return state;
}
