import { Router } from 'express';
import { z } from 'zod';
import { createJob } from '../jobs.js';

export const searchRoute = Router();

const Body = z.object({
  neighborhoods: z.array(z.string().min(1)).min(1).max(10),
  include_pozo: z.boolean().optional().default(false),
  include_construccion: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  min_yield: z.number().min(0).max(1).optional(),
  min_build_yield: z.number().min(0).max(1).optional(),
});

searchRoute.post('/', (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  const { neighborhoods, ...options } = parsed.data;
  const job = createJob({ neighborhoods, options });
  res.json({ job_id: job.id, started_at: job.started_at });
});
