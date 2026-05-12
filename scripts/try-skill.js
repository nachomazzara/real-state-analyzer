// One-shot skill tester: run a single scraping skill and dump the result.
// Usage:
//   docker compose exec app node scripts/try-skill.js scrape-zonaprop palermo venta 1
//   docker compose exec app node scripts/try-skill.js scrape-mercadolibre belgrano alquiler 0
//   docker compose exec app node scripts/try-skill.js scrape-remax palermo venta 1
import { runSkill } from '../src/agent.js';

const [, , skill, neighborhood, operation, pageOrOffset = '1'] = process.argv;

if (!skill || !neighborhood || !operation) {
  console.error('usage: node scripts/try-skill.js <skill> <neighborhood-id> <operation> [page|offset]');
  process.exit(2);
}

const vars = {
  NEIGHBORHOOD_ID: neighborhood,
  NEIGHBORHOOD_DISPLAY: neighborhood.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  OPERATION: operation,
  PAGE: Number(pageOrOffset) || 1,
  OFFSET: Number(pageOrOffset) || 0,
  OFFSET_PLUS_1: (Number(pageOrOffset) || 0) + 1,
  REMAX_OP: operation === 'venta' ? 'buy' : 'rent',
};

const started = Date.now();
try {
  const result = await runSkill({ skill, vars });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const count = Array.isArray(result?.listings) ? result.listings.length : 0;
  console.log(`[try-skill] ${skill} → ${count} listings in ${elapsed}s, has_more=${result?.has_more}`);
  console.log('first 2 listings:');
  console.log(JSON.stringify((result.listings || []).slice(0, 2), null, 2));
} catch (err) {
  console.error('[try-skill] FAILED:', err.message);
  process.exit(1);
}
