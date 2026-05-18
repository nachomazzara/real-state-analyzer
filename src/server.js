import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { getDb, isReady } from './db.js';
import { fxRoute } from './routes/fx.js';
import { searchRoute } from './routes/search.js';
import { jobsRoute } from './routes/jobs.js';
import { statsRoute } from './routes/stats.js';
import { propertiesRoute } from './routes/properties.js';
import { neighborhoodsRoute } from './routes/neighborhoods.js';
import { sourcesRoute } from './routes/sources.js';
import { analysesRoute } from './routes/analyses.js';
import { resumePendingGeocoding } from './pipeline/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '256kb' }));

app.use((req, _res, next) => {
  if (req.path === '/healthz') return next();
  logger.info({ method: req.method, path: req.path, q: req.query }, 'http');
  next();
});

app.get('/healthz', (_req, res) => {
  if (isReady()) return res.status(200).send('ok');
  return res.status(503).send('db not ready');
});

app.use('/api/fx', fxRoute);
app.use('/api/search', searchRoute);
app.use('/api/jobs', jobsRoute);
app.use('/api/stats', statsRoute);
app.use('/api/properties', propertiesRoute);
app.use('/api/neighborhoods', neighborhoodsRoute);
app.use('/api/sources', sourcesRoute);
app.use('/api/analyses', analysesRoute);

app.use(express.static(publicDir));

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled request error');
  res.status(500).json({ error: 'internal_error' });
});

getDb();

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'real-state-analyzer listening');
  // Resume any pending geocoding work left over from a previous run (or from
  // a one-shot SQL backfill). No-op when ENABLE_SUBZONES is off or when no
  // listings have addresses without lat/lng.
  resumePendingGeocoding().catch((err) => {
    logger.warn({ err: err.message }, 'resumePendingGeocoding failed');
  });
});
