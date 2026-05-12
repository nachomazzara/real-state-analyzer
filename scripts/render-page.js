#!/usr/bin/env node
// Renders a JS-heavy page with Playwright and prints the resulting body
// innerText (or, with --html, the full DOM) to stdout. Used by the auto-heal
// agent skill to extract data when the direct scraper falls short.
//
// Usage:
//   node scripts/render-page.js <URL>
//   node scripts/render-page.js --html <URL>
//   node scripts/render-page.js --timeout 60000 <URL>

import { newContext, closeBrowser } from '../src/browser.js';

async function main() {
  const args = process.argv.slice(2);
  let mode = 'text';
  let timeoutMs = 45_000;
  let url = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--html') mode = 'html';
    else if (args[i] === '--timeout') timeoutMs = Number(args[++i]) || 45_000;
    else url = args[i];
  }
  if (!url) {
    console.error('usage: render-page.js [--html] [--timeout MS] <URL>');
    process.exit(2);
  }

  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForTimeout(5_000);
    const out = await page.evaluate(
      (m) => (m === 'html' ? document.documentElement.outerHTML : document.body.innerText),
      mode,
    );
    process.stdout.write(out);
  } catch (err) {
    console.error('render-page failed:', err.message);
    process.exit(1);
  } finally {
    await ctx.close().catch(() => {});
    await closeBrowser().catch(() => {});
  }
}

main();
