import { Router } from 'express';
import { z } from 'zod';
import {
  upsertAnalysis,
  getAnalysis,
  listAnalyses,
  touchAnalysis,
  setLastScrapeJob,
} from '../analyses.js';
import { createJob } from '../jobs.js';

export const analysesRoute = Router();

const FiltersSchema = z
  .object({
    include_pozo: z.boolean().optional(),
    include_construccion: z.boolean().optional(),
    require_pool: z.boolean().optional(),
    require_garage: z.boolean().optional(),
    min_rooms: z.number().min(1).max(10).optional(),
    max_rooms: z.number().min(1).max(10).optional(),
    min_yield: z.number().min(0).max(1).optional(),
    min_build_yield: z.number().min(0).max(1).optional(),
  })
  .strict()
  .partial();

const CreateBody = z.object({
  neighborhoods: z.array(z.string().min(1)).min(1).max(10),
  filters: FiltersSchema.optional().default({}),
});

analysesRoute.post('/', (req, res) => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const analysis = upsertAnalysis(parsed.data);
  res.json(analysis);
});

analysesRoute.get('/', (_req, res) => {
  res.json({ analyses: listAnalyses(20) });
});

analysesRoute.get('/:id', (req, res) => {
  const a = getAnalysis(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  res.json(a);
});

analysesRoute.post('/:id/view', (req, res) => {
  const a = getAnalysis(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  touchAnalysis(a.id);
  res.json({ ok: true });
});

const ScrapeBody = z
  .object({
    force: z.boolean().optional().default(false),
  })
  .partial();

analysesRoute.post('/:id/scrape', (req, res) => {
  const a = getAnalysis(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  const opts = ScrapeBody.parse(req.body || {});
  const job = createJob({
    neighborhoods: a.neighborhoods,
    options: { ...opts, analysis_id: a.id, ...a.filters },
  });
  setLastScrapeJob(a.id, job.id);
  res.json({ job_id: job.id, started_at: job.started_at, analysis_id: a.id });
});
