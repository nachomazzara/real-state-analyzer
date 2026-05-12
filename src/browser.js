// Plain playwright. We tried rebrowser-playwright but its CDP patches throw
// "cannot get world" errors during Runtime.evaluate, which Cloudflare may
// read as suspicious. With channel:'chrome' + ignoreDefaultArgs the plain
// version is less buggy and gets equivalent results.
import { chromium } from 'playwright';
import path from 'node:path';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';

let persistentCtx = null;
let launching = null; // in-flight launch promise — concurrent callers await this

// Scraper profile lives next to data, isolated from the user's daily Chrome.
// Real Chrome binary (channel: 'chrome') + headed-but-minimized — same pattern
// personal-assistant uses to defeat fingerprint walls (zonaprop's DataDome).
function profileDir() {
  const dir = path.join(config.dataDir, '.chrome-profile');
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return dir;
}

async function getPersistentContext() {
  if (persistentCtx) return persistentCtx;
  // Serialize concurrent first-time callers. Without this, two scrapers that
  // both call newContext() before launch finishes would each invoke
  // launchPersistentContext, racing on the SingletonLock symlink — the
  // second loses with "File exists (17)" and the scrape errors out.
  if (launching) return launching;
  launching = (async () => {
    // Wipe the scraper profile on each cold start. We have nothing worth
    // preserving here — cookies are re-injected from data/ml-cookies.txt at
    // launch, and a fresh profile prevents Chrome from popping a "Something
    // went wrong" recovery dialog after a previous run was killed (Ctrl+C,
    // crash) leaving session files in a half-written state. The dir is
    // recreated by mkdir below.
    const profile = profileDir();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(profile, { recursive: true });
    logger.info({ profile }, 'launching real Chrome (channel=chrome, headed off-screen)');
  persistentCtx = await chromium.launchPersistentContext(profileDir(), {
    channel: 'chrome',
    headless: false,
    // Strip Playwright's default automation flags. They set navigator.webdriver=true,
    // show the "Chrome is being controlled by automated test software" banner,
    // and disable session restore — all of which Cloudflare's bot detector
    // reads. Removing them makes the browser look like a normal user-launched
    // Chrome. CDP still works (it uses --remote-debugging-pipe).
    ignoreDefaultArgs: ['--enable-automation', '--disable-component-update', '--no-default-browser-check'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-position=-2000,-2000',
      '--window-size=1366,850',
      '--disable-features=Translate,InterestFeedContentSuggestions',
      '--password-store=basic',
      '--use-mock-keychain',
    ],
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    viewport: { width: 1366, height: 850 },
  });
  // Block font network requests + ML's font-fingerprinting trackers. ML's
  // `snoopy-search.js` (and a sibling anti-fraud bundle) probe the system for
  // installed fonts as a bot-detection signal — iterating through Osaka,
  // STHeiti, Hiragino, MS Gothic, etc. Each probe triggers macOS Font Book to
  // pop a download dialog at the user. The script is pure tracking; aborting
  // it leaves the listing page fully functional but ends the popups.
  const TRACKER_RE =
    /\/(snoopy|datadome|hcaptcha|recaptcha)|fonts\.googleapis\.com|connect\.facebook\.net|google-analytics\.com|googletagmanager\.com|hotjar\.com|doubleclick\.net|googlesyndication\.com|adsystem\.com|criteo\.com|taboola\.com|outbrain\.com|amplitude\.com|segment\.(?:com|io)|mixpanel\.com|fullstory\.com|newrelic\.com|nr-data\.net|bugsnag\.com|sentry\.io|clarity\.ms/i;
  await persistentCtx.route('**', async (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === 'font') return route.abort();
    if (TRACKER_RE.test(req.url())) return route.abort();
    return route.continue();
  });
  // Belt-and-braces: override font-family for every element via a high-
  // specificity rule. Runs on every page navigation. Even if some inline CSS
  // slips past the route interceptor, this kills the Osaka request at the
  // CSSOM layer.
  await persistentCtx.addInitScript(() => {
    const inject = () => {
      if (!document.documentElement) return requestAnimationFrame(inject);
      const style = document.createElement('style');
      style.id = '__no-osaka';
      style.textContent =
        '*, *::before, *::after { ' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; ' +
        '}';
      (document.head || document.documentElement).appendChild(style);
    };
    inject();
  });
  await persistentCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Kill site-initiated popups (ads, tracking iframes that bust out, etc.).
    // Playwright launches Chrome with --disable-popup-blocking so anything
    // calling window.open spawns a real OS window. Stub it out at runtime.
    window.open = () => null;
  });
  await loadManualCookies(persistentCtx);
  // No more window-state juggling: macOS un-minimizes Chrome every time a
  // new tab opens, so re-minimizing per page caused a constant flicker. The
  // user asked to let the window sit wherever Chrome puts it. Cmd+H or move
  // it once and macOS leaves it alone.
    return persistentCtx;
  })();
  try {
    return await launching;
  } catch (err) {
    launching = null; // allow a fresh launch on the next call
    throw err;
  }
}

// Serialize tab creation so concurrent newPage() calls reliably correlate
// their CDP createTarget with the matching playwright Page event.
let tabCreateChain = Promise.resolve();
// A page we keep alive forever to serve as the "parent" for every CDP
// Target.createTarget call. Without this, when scrapers churn through tabs,
// the source page we pick (ctx.pages()[0]) can get closed mid-flight and the
// next createTarget falls back to opening a new OS window.
let anchorPage = null;

async function getAnchorPage(ctx) {
  if (anchorPage && !anchorPage.isClosed()) return anchorPage;
  // Reuse the initial about:blank if it's still around — otherwise open one.
  const existing = ctx.pages().find((p) => !p.isClosed());
  anchorPage = existing || (await ctx.newPage());
  return anchorPage;
}

async function createTab(ctx) {
  // Always derive the CDP session from a stable anchor page so newWindow=false
  // truly opens a tab in the existing window every time.
  const source = await getAnchorPage(ctx);
  const cdp = await ctx.newCDPSession(source);
  const pagePromise = new Promise((resolve) => ctx.once('page', resolve));
  try {
    await cdp.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: false,
      // background:true means the new tab opens behind the active one without
      // pulling the window to the foreground. Without this, every newPage()
      // un-minimizes the Chrome window, our handler re-minimizes, and the
      // user sees a flicker of minimize/maximize per tab.
      background: true,
    });
  } catch (err) {
    logger.debug({ err: err.message }, 'CDP createTarget failed, falling back to ctx.newPage');
    return ctx.newPage();
  } finally {
    await cdp.detach().catch(() => {});
  }
  return pagePromise;
}

// Drop-in replacement for per-call context: returns an object with .newPage()
// and .close(). .close() closes only pages opened here; the underlying
// singleton persistent context stays alive for the process.
export async function newContext() {
  const ctx = await getPersistentContext();
  const myPages = new Set();
  return {
    async newPage() {
      const next = tabCreateChain.then(() => createTab(ctx));
      tabCreateChain = next.catch(() => {}); // don't poison the chain
      const p = await next;
      myPages.add(p);
      return p;
    },
    async close() {
      for (const p of myPages) {
        await p.close().catch(() => {});
      }
      myPages.clear();
    },
    _underlying: ctx,
  };
}

// Load cookies the user pasted manually into one of:
//   data/ml-cookies.txt  — raw Cookie header string (name=val; name2=val2; ...)
//   data/ml-cookies.json — Playwright-style array [{name, value, domain, ...}]
// The .txt form is the easiest to produce from Chrome DevTools: open the
// Network tab on mercadolibre.com.ar, find the document request, right-click
// the "cookie:" header → Copy value, paste into the file. We assume the
// domain is .mercadolibre.com.ar for every entry in the .txt form.
// Read ml-cookies.{json,txt} from disk and parse into Playwright cookie shape.
// Cached at process start; reset() forces a fresh read.
let cachedMlCookies = null;
function readMlCookiesFromDisk() {
  if (cachedMlCookies) return cachedMlCookies;
  const txt = path.join(config.dataDir, 'ml-cookies.txt');
  const json = path.join(config.dataDir, 'ml-cookies.json');
  let cookies = [];
  if (existsSync(json)) {
    try {
      const arr = JSON.parse(readFileSync(json, 'utf-8'));
      if (Array.isArray(arr)) cookies = arr;
    } catch (err) {
      logger.warn({ err: err.message, file: json }, 'ml-cookies.json invalid; ignoring');
    }
  } else if (existsSync(txt)) {
    const raw = readFileSync(txt, 'utf-8').trim();
    const body = raw.replace(/^cookie:\s*/i, '').replace(/\s+/g, ' ');
    cookies = body
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return null;
        return {
          name: pair.slice(0, eq).trim(),
          value: pair.slice(eq + 1).trim(),
          domain: '.mercadolibre.com.ar',
          path: '/',
        };
      })
      .filter(Boolean);
  } else {
    cachedMlCookies = [];
    return cachedMlCookies;
  }
  cachedMlCookies = cookies
    .map((c) => ({
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain || '.mercadolibre.com.ar',
      path: c.path || '/',
      expires: Number.isFinite(c.expires) && c.expires > 0 ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: c.secure ?? true,
      sameSite: c.sameSite || 'Lax',
    }))
    .filter((c) => c.name);
  return cachedMlCookies;
}

// Reload the persistent context's MercadoLibre cookies from disk. Call before
// every ML detail-page navigation: ML sets bot-detection cookies on the first
// response that taint the session for subsequent requests, identical to the
// zonaprop case. Resetting the cookie jar restores the known-good state.
export async function refreshMlCookies(underlyingCtx) {
  const cookies = readMlCookiesFromDisk();
  if (cookies.length === 0) return false;
  try {
    await underlyingCtx.clearCookies({ domain: '.mercadolibre.com.ar' }).catch(() => {});
    await underlyingCtx.clearCookies({ domain: 'mercadolibre.com.ar' }).catch(() => {});
    await underlyingCtx.addCookies(cookies);
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, 'refreshMlCookies failed');
    return false;
  }
}

async function loadManualCookies(ctx) {
  const cookies = readMlCookiesFromDisk();
  if (cookies.length === 0) return;
  try {
    await ctx.addCookies(cookies);
    logger.info({ count: cookies.length }, 'loaded manual ML cookies');
  } catch (err) {
    logger.warn({ err: err.message }, 'addCookies failed for manual ML cookies');
  }
}

export async function closeBrowser() {
  if (persistentCtx) {
    await persistentCtx.close().catch(() => {});
    persistentCtx = null;
  }
}
