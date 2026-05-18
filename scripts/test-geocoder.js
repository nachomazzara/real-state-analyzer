// Standalone geocoder bench. Reads all addresses from the DB, runs them
// through the full geocode() pipeline (cleaner + USIG + fuzzy + intersection +
// ±altura sweep + word-strip + Nominatim), and writes the failures to
// output_error.txt with enough context to debug.
//
// Usage:
//   node --env-file=.env scripts/test-geocoder.js               # all rows
//   node --env-file=.env scripts/test-geocoder.js --limit=200   # first 200
//   node --env-file=.env scripts/test-geocoder.js --only-uncached  # skip cache hits
//   node --env-file=.env scripts/test-geocoder.js --filter=Saavedra
//
// Output:
//   - stdout: progress + summary
//   - output_error.txt: one entry per fail, with source/url/raw/cleaned
//   - output_success.txt: one entry per success (raw → coords)

import { writeFileSync, appendFileSync } from 'node:fs';
import { getDb } from '../src/db.js';
import { geocode, cleanAddressForGeocoding } from '../src/pipeline/geocode.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : ['_', a];
  }),
);

const ERROR_PATH = 'output_error.txt';
const SUCCESS_PATH = 'output_success.txt';
const limit = Number(args.limit) || null;
const filter = args.filter || null;
const onlyUncached = !!args['only-uncached'];

const db = getDb();
let sql = `
  SELECT id, source, neighborhood, url, address
  FROM listings
  WHERE active=1 AND address IS NOT NULL
`;
if (filter) sql += ` AND (neighborhood = '${filter.replace(/'/g, "''")}' OR source = '${filter.replace(/'/g, "''")}')`;
if (onlyUncached) sql += ` AND lat IS NULL`;
if (limit) sql += ` LIMIT ${Number(limit)}`;

const rows = db.prepare(sql).all();
console.log(`testing ${rows.length} addresses`);
if (rows.length === 0) process.exit(0);

writeFileSync(ERROR_PATH, `# geocoder failures (generated ${new Date().toISOString()})\n# total tested: ${rows.length}\n\n`);
writeFileSync(SUCCESS_PATH, `# geocoder successes (generated ${new Date().toISOString()})\n# total tested: ${rows.length}\n\n`);

const stats = { ok: 0, fail: 0, bySource: {}, failBySource: {}, failByPattern: {} };
const PROGRESS_EVERY = 25;
const t0 = Date.now();

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  stats.bySource[row.source] = (stats.bySource[row.source] || 0) + 1;
  const cleaned = cleanAddressForGeocoding(row.address);
  const result = await geocode(row.address);
  if (result) {
    stats.ok++;
    appendFileSync(SUCCESS_PATH, `[${row.source}] ${row.address}  →  cleaned="${cleaned}"  →  lat=${result.lat.toFixed(4)} lng=${result.lng.toFixed(4)} (${result.source})\n`);
  } else {
    stats.fail++;
    stats.failBySource[row.source] = (stats.failBySource[row.source] || 0) + 1;
    // Classify common failure patterns so we know where to focus next.
    let pattern = 'unknown';
    const raw = row.address;
    if (cleaned == null) pattern = 'cleaner-rejected';
    else if (/m[2²]|ambientes?|monoambiente|depto|departamento|excelente|cfte|bcon|balc[oó]n|suite|cochera|lavadero|vestidor/i.test(raw)) pattern = 'title-text';
    else if (/esquina|esq\.|\sy\s/i.test(raw)) pattern = 'intersection';
    else if (/^\d/.test(raw)) pattern = 'starts-with-digit';
    else if (raw.split(/\s+/).length > 5) pattern = 'too-many-words';
    else if (/\bde\b/i.test(raw)) pattern = 'has-de';
    else pattern = 'other';
    stats.failByPattern[pattern] = (stats.failByPattern[pattern] || 0) + 1;
    appendFileSync(
      ERROR_PATH,
      `[${row.source}] id=${row.id} pattern=${pattern}\n  raw:     ${JSON.stringify(raw)}\n  cleaned: ${JSON.stringify(cleaned)}\n  url:     ${row.url}\n\n`,
    );
  }
  if ((i + 1) % PROGRESS_EVERY === 0 || i === rows.length - 1) {
    const pct = ((i + 1) / rows.length * 100).toFixed(1);
    const eta = ((Date.now() - t0) / (i + 1) * (rows.length - i - 1) / 1000).toFixed(0);
    console.log(`${i + 1}/${rows.length} (${pct}%) ok=${stats.ok} fail=${stats.fail} ETA ${eta}s`);
  }
}

console.log('\n=== SUMMARY ===');
console.log(`total:      ${rows.length}`);
console.log(`ok:         ${stats.ok} (${(stats.ok / rows.length * 100).toFixed(1)}%)`);
console.log(`fail:       ${stats.fail} (${(stats.fail / rows.length * 100).toFixed(1)}%)`);
console.log(`elapsed:    ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('\nby source:');
for (const s of Object.keys(stats.bySource)) {
  const total = stats.bySource[s];
  const f = stats.failBySource[s] || 0;
  console.log(`  ${s.padEnd(15)} total=${String(total).padStart(5)}  fail=${String(f).padStart(5)} (${(f / total * 100).toFixed(1)}%)`);
}
console.log('\nfails by pattern:');
for (const [p, n] of Object.entries(stats.failByPattern).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(20)} ${n}`);
}
console.log(`\noutput_error.txt has the failures. output_success.txt has the wins.`);

process.exit(0);
