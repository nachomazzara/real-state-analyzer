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
  // CDP attach path — when CHROME_CDP_URL is set, connect to a Chrome the
  // user already has open (started with --remote-debugging-port=9222).
  // This bypasses Playwright's launch flow entirely, which means we
  // inherit the user's logged-in session, organic cookies, browsing
  // history fingerprint, etc. The single most effective anti-detection
  // trick: don't run a fresh browser, ride the human's.
  const cdpUrl = process.env.CHROME_CDP_URL;
  if (cdpUrl) {
    launching = (async () => {
      logger.info({ cdpUrl }, 'connecting to existing Chrome via CDP');
      const browser = await chromium.connectOverCDP(cdpUrl);
      // The first context is the user's default — it carries their cookies,
      // storage, browsing history, and crucially the organic browser
      // fingerprint that ML's anti-bot trusts. We do NOT install request
      // routing or anti-detection init scripts here: doing so would disrupt
      // the user's normal browsing AND undo the very thing that makes this
      // path effective (looking like a real human session, not a tweaked
      // automation one). We also do NOT call loadManualCookies — the live
      // browser already has the right cookies; overwriting from ml-cookies.txt
      // would corrupt the session.
      const ctxs = browser.contexts();
      if (ctxs.length === 0) {
        throw new Error(`CDP attach: no contexts found at ${cdpUrl} — is the Chrome window open?`);
      }
      persistentCtx = ctxs[0];
      logger.info({ pages: persistentCtx.pages().length }, 'CDP attach OK — reusing user session');
      return persistentCtx;
    })();
    try {
      return await launching;
    } catch (err) {
      launching = null;
      throw err;
    }
  }
  launching = (async () => {
    // Persistent profile across runs. We used to wipe it on each cold start
    // (clean slate, no recovery dialogs) but that made ML's bot detector
    // serve us a self-redirecting challenge page — same URL navigating to
    // itself every ~1s in an infinite loop, so domcontentloaded never fired
    // and every detail-page goto timed out. Letting Chrome accumulate
    // IndexedDB / Local Storage / Cookies that ML sets in response to our
    // legitimate cookies makes the profile look like a returning user.
    // Only the SingletonLock files are cleaned (they cause "File exists"
    // launch errors after an unclean shutdown).
    const profile = profileDir();
    mkdirSync(profile, { recursive: true });
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { rmSync(path.join(profile, f), { force: true }); } catch { /* ignore */ }
    }
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
  // Three categories of request manipulation:
  //
  // 1) FONTS_RE: ML's anti-fraud scripts (snoopy-search.js, datadome) probe
  //    the system for installed fonts by trying to load Osaka, STHeiti,
  //    Hiragino, etc. — each missing font triggers macOS Font Book to pop
  //    a "Download Osaka" dialog. Originally we route.abort()'d these, but
  //    ML's frontend detects the abort and traps us in an infinite self-
  //    redirect loop. Instead we route.fulfill() with an empty 200 body so
  //    the script "loads" successfully but the probe code never executes.
  //
  // 2) Font network requests (type === 'font') — same deal, just the actual
  //    font binary fetches that follow the snoopy probe.
  //
  // 3) TRACKER_RE: pure third-party telemetry. Aborting these is fine; ML
  //    doesn't care if Google Analytics fails to load.
  const FONTPROBE_RE = /\/(snoopy|datadome|hcaptcha|recaptcha|fonts\.googleapis\.com|fonts\.gstatic\.com)/i;
  const TRACKER_RE =
    /connect\.facebook\.net|google-analytics\.com|googletagmanager\.com|hotjar\.com|doubleclick\.net|googlesyndication\.com|adsystem\.com|criteo\.com|taboola\.com|outbrain\.com|amplitude\.com|segment\.(?:com|io)|mixpanel\.com|fullstory\.com|newrelic\.com|nr-data\.net|bugsnag\.com|sentry\.io|clarity\.ms/i;
  await persistentCtx.route('**', async (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (type === 'font') {
      return route.fulfill({ status: 200, contentType: 'font/woff2', body: '' });
    }
    if (FONTPROBE_RE.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* stubbed */' });
    }
    if (TRACKER_RE.test(url)) return route.abort();
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
    // In CDP-attach mode, do NOT call .close() — that would close the user's
    // own Chrome window. Just drop the reference; the user controls their
    // browser's lifetime.
    if (!process.env.CHROME_CDP_URL) {
      await persistentCtx.close().catch(() => {});
    }
    persistentCtx = null;
  }
}
