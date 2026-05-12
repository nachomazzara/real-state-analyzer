import { Router } from 'express';
import { getJob } from '../jobs.js';
import { getDb } from '../db.js';

export const jobsRoute = Router();

jobsRoute.get('/', (_req, res) => {
  // Recent jobs (last 10), useful for the UI to recover a session.
  const rows = getDb()
    .prepare(
      `SELECT id, neighborhoods, status, started_at, finished_at
       FROM jobs ORDER BY started_at DESC LIMIT 10`,
    )
    .all();
  res.json({
    jobs: rows.map((r) => ({
      id: r.id,
      neighborhoods: r.neighborhoods.split(','),
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at,
    })),
  });
});

jobsRoute.get('/:id', (req, res) => {
  const inMem = getJob(req.params.id);
  if (inMem) return res.json(inMem);
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({
    id: row.id,
    neighborhoods: row.neighborhoods.split(','),
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    counts: safeParse(row.counts_json),
    options: safeParse(row.options_json),
    error: row.error ? safeParse(row.error) : null,
  });
});

function safeParse(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
