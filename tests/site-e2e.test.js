// End-to-end test of the built site, served the way Vercel serves it
// (tests/lib/vercel-local.js: dist/ + vercel.json redirects/rewrites +
// POST /api/growth-check through the real handler), driven by Playwright.
//
//   npm run test:e2e            (builds first)
//   node tests/site-e2e.test.js (uses the existing dist/)
//
// Env:
//   E2E_PORT   local port (default 4312; keep within 4301-4320)
//   SHOTS_DIR  if set, screenshots are saved there (desktop 1280 + phone 390)
//
// Needs Playwright's Chromium (require('playwright') must resolve, from
// node_modules or NODE_PATH) and internet access for the live Growth Check of
// tuskertees.com. DD Hub is paused until about 1 Nov, so its visit counter
// (hub.digitaldominant.co.uk/t.js) is answered with an empty script here: the
// test checks this site's own code, and nothing on it may depend on the Hub.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVercelLocal } from './lib/vercel-local.js';
import { parseSrcset, scanHtml } from '../api/_lib/growth-check-core.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.E2E_PORT) || 4312;
const SHOTS = process.env.SHOTS_DIR || '';
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true };
const DESKTOP = { width: 1280, height: 900, isMobile: false, hasTouch: false };
const MENU = ['Services', 'Our Work', 'Free Audit', 'About', 'Book a call', 'Client login'];
const FOOTER = [
  ['Services', 'services.html'],
  ['Plans', 'services.html#plans'],
  ['Our Work', 'work.html'],
  ['Free Growth Check', '/growth-check'],
  ['About', 'about.html'],
  ['Contact', 'contact.html'],
  ['Influencers Lab', 'influencers-lab.html'],
  ['Lead Leak Calculator', 'calculator.html'],
  ['Client login (DD Hub)', 'hub.html'],
];

let chromium;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  throw new Error('Playwright is not installed here. Install it (npm i -D playwright) or put it on NODE_PATH.');
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('No build found. Run "npx vite build" first (npm run test:e2e does both).');
}

let server;
let browser;
let origin;

before(async () => {
  server = await startVercelLocal({ port: PORT });
  origin = server.url;
  browser = await chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Every built page except Google's site-verification file (google<hex>.html).
const builtPages = () => readdirSync(DIST).filter((f) => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(f));
const readBuilt = (file) => readFileSync(path.join(DIST, file), 'utf8');

function tagsOf(html) {
  const tags = [];
  scanHtml(html, { tag: (t) => tags.push(t) });
  return tags;
}

// The text inside elements matched by an opening tag, e.g. every <a> in a block.
function linksIn(html) {
  const out = [];
  let open = null;
  scanHtml(html, {
    tag(t) {
      if (t.name === 'a' && !t.closing) open = { attrs: t.attrs, start: t.end };
      else if (t.name === 'a' && t.closing && open) {
        out.push({ ...open.attrs, text: html.slice(open.start, t.start).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() });
        open = null;
      }
    },
  });
  return out;
}

function between(html, startRe, endText) {
  const m = startRe.exec(html);
  if (!m) return '';
  const end = html.indexOf(endText, m.index);
  return html.slice(m.index, end === -1 ? html.length : end + endText.length);
}

async function openPage(viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = (msg.location() && msg.location().url) || '';
    // A third-party file (fonts, a stock photo) that the network dropped is not this site's error.
    if (/^Failed to load resource/.test(msg.text()) && where && !where.startsWith(origin)) return;
    errors.push(`console: ${msg.text()} ${where}`);
  });
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('requestfailed', (req) => {
    if (req.url().startsWith(origin)) errors.push(`request failed: ${req.url()} ${req.failure() && req.failure().errorText}`);
  });
  page.on('response', (res) => {
    if (res.url().startsWith(origin) && res.status() >= 400) errors.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  await page.route('https://hub.digitaldominant.co.uk/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* DD Hub is paused; visit counter stubbed in tests */' }),
  );
  return { context, page, errors };
}

// Full-page screenshots: show the scroll-in animations, let lazy images load,
// then put the page back at the top so the fixed menu sits where it belongs.
async function settleForFullPage(page) {
  await page.addStyleTag({ content: '[data-aos]{opacity:1!important;transform:none!important;transition:none!important}' });
  await page.evaluate(async () => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 60));
    }
    await Promise.all(
      [...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; setTimeout(r, 4000); }))),
    );
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(250);
}

async function shot(page, name, options = {}) {
  if (!SHOTS) return;
  if (options.fullPage) await settleForFullPage(page);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: Boolean(options.fullPage) });
}

// Links a person can actually see: displayed, and inside the menu's visible
// box (the closed phone menu is a max-height: 0 box that clips its links).
async function visibleMenuItems(page) {
  return page.$$eval('#site-nav a', (links) => {
    const menu = document.getElementById('site-nav').getBoundingClientRect();
    return links
      .filter((a) => {
        const style = getComputedStyle(a);
        const box = a.getBoundingClientRect();
        const middle = box.top + box.height / 2;
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          box.width > 0 &&
          box.height > 0 &&
          middle >= menu.top &&
          middle <= menu.bottom
        );
      })
      .map((a) => a.textContent.trim());
  });
}

// ---------------------------------------------------------------------------
// Static checks on the build and vercel.json
// ---------------------------------------------------------------------------
test('vercel.json: /pricing.html and /pricing redirect permanently to /services.html#plans', () => {
  const config = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.deepEqual(
    config.redirects.find((r) => r.source === '/pricing.html'),
    { source: '/pricing.html', destination: '/services.html#plans', permanent: true },
  );
  assert.deepEqual(
    config.redirects.find((r) => r.source === '/pricing'),
    { source: '/pricing', destination: '/services.html#plans', permanent: true },
  );
  assert.ok(config.rewrites.some((r) => r.source === '/growth-check' && r.destination === '/growth-check.html'));
  assert.equal(config.functions['api/growth-check.js'].maxDuration, 60);
  // The target and its anchor exist, and the old page still works without Vercel.
  assert.match(readBuilt('services.html'), /\bid="plans"/);
  const pricing = readBuilt('pricing.html');
  assert.match(pricing, /<meta http-equiv="refresh" content="0; url=\/services\.html#plans"/);
  assert.match(pricing, /<a href="\/services\.html#plans">/);
  assert.match(pricing, /noindex/);
});

test('every page has the new menu and footer, and no link to the paused Hub audit', () => {
  for (const file of builtPages()) {
    const html = readBuilt(file);
    assert.doesNotMatch(html, /hub\.digitaldominant\.co\.uk\/audit/, `${file} links the Hub audit`);
    if (!html.includes('class="navbar"')) continue; // the tiny redirect pages
    const nav = between(html, /<nav class="navbar"/, '</nav>');
    const menu = linksIn(between(nav, /<div class="nav-links"/, '</div>'));
    assert.deepEqual(menu.map((a) => a.text), MENU, `${file} menu`);
    assert.deepEqual(menu.map((a) => a.href), [
      'services.html', 'work.html', '/growth-check', 'about.html', 'https://calendly.com/digitaldominant/30min', 'hub.html',
    ], `${file} menu links`);
    const actions = linksIn(between(nav, /<div class="nav-actions"/, '</div>'));
    assert.deepEqual(actions.map((a) => [a.text, a.href]), [
      ['Client login', 'hub.html'],
      ['Book a call', 'https://calendly.com/digitaldominant/30min'],
    ], `${file} desktop actions`);
    assert.doesNotMatch(nav, />Home</, `${file}: no separate Home link`);
    const footer = between(html, /<footer class="footer"/, '</footer>');
    const footerLinks = linksIn(footer).map((a) => [a.text, a.href]);
    for (const expected of FOOTER) assert.ok(footerLinks.some(([t, h]) => t === expected[0] && h === expected[1]), `${file} footer has ${expected[0]}`);
    assert.ok(footerLinks.some(([t, h]) => t === 'Privacy Policy' && h === 'privacy-policy.html'), `${file} footer privacy`);
    assert.ok(footerLinks.some(([t, h]) => t === 'Terms & Conditions' && h === 'terms-conditions.html'), `${file} footer terms`);
    for (const link of linksIn(html)) {
      if (/Free (Audit|Growth Check)|free check|Growth Check/i.test(link.text) && link.href && !link.href.startsWith('#')) {
        assert.equal(link.href, '/growth-check', `${file}: "${link.text}" goes to ${link.href}`);
      }
    }
  }
});

test('homepage: six sections in the agreed order, short FAQ, no Hyderabad', () => {
  const html = readBuilt('index.html');
  const main = between(html, /<main id="main"/, '</main>');
  const sections = [];
  let depth = 0;
  scanHtml(main, {
    tag(t) {
      if (t.name !== 'section' && t.name !== 'header') return;
      if (t.closing) depth -= 1;
      else {
        if (depth === 0) sections.push(t.attrs.id);
        depth += 1;
      }
    },
  });
  assert.deepEqual(sections, ['home', 'services', 'work', 'calculator', 'how', 'free-check']);
  const headings = [];
  let open = null;
  scanHtml(main, {
    tag(t) {
      if ((t.name === 'h1' || t.name === 'h2') && !t.closing) open = t.end;
      else if ((t.name === 'h1' || t.name === 'h2') && t.closing && open !== null) {
        headings.push(main.slice(open, t.start).replace(/<[^>]*>/g, '').replace(/&rsquo;/g, '’').trim());
        open = null;
      }
    },
  });
  assert.deepEqual(headings, [
    'Where paid clicks go to die.',
    'One team for the site, the ads and the software behind them',
    'The same system, already running',
    'How much is the leak costing you?',
    'Two phases, one number we report on',
    'See what’s leaking on your site in 30 seconds',
    'Questions owners ask',
  ]);
  assert.match(main, /owner-led service businesses that already pay for clicks/);
  const questions = (main.match(/<summary>/g) || []).length;
  assert.ok(questions >= 4 && questions <= 5, `${questions} FAQ questions`);
  assert.doesNotMatch(main, /What changes when you switch|class="compare/);
  assert.doesNotMatch(html, /Hyderabad/i);
});

test('no page says Hyderabad (except the two legacy Hyderabad landing pages) and none shows rupee prices', () => {
  const legacy = new Set(['website-design-hyderabad.html', 'google-ads-hyderabad.html']);
  for (const file of builtPages()) {
    const html = readBuilt(file);
    if (!legacy.has(file)) assert.doesNotMatch(html, /Hyderabad/i, `${file} mentions Hyderabad`);
    assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /(?:₹|&#8377;)\s?\d|\bRs\.?\s?\d/, `${file} shows a rupee price`);
  }
});

test('services page: five services, plans, no prices', () => {
  const html = readBuilt('services.html');
  for (const id of ['website-rebuild', 'google-ads', 'meta-ads', 'custom-software', 'reviews', 'influencers-lab', 'plans', 'included', 'phase-1', 'phase-2', 'reviews-engine', 'guarantee', 'faq']) {
    assert.match(html, new RegExp(`\\bid="${id}"`), `#${id}`);
  }
  for (const href of ['hub.html', 'influencers-lab.html', 'calculator.html', '/growth-check']) assert.ok(html.includes(`href="${href}"`), href);
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /[$₹£€]\s?\d/, 'no prices on the services page');
  assert.doesNotMatch(html, /Hyderabad/i);
});

// ---------------------------------------------------------------------------
// Every internal link resolves, as Vercel would serve it
// ---------------------------------------------------------------------------
async function resolve(url) {
  // Follow redirects by hand so a redirect's own #fragment (Vercel sends
  // /pricing.html -> /services.html#plans) is the one that counts.
  let current = new URL(url);
  const hops = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location'), current);
      if (!next.hash) next.hash = current.hash;
      hops.push(`${res.status} ${next.pathname}${next.hash}`);
      current = next;
      continue;
    }
    const body = res.headers.get('content-type')?.includes('text/html') ? await res.text() : (await res.arrayBuffer(), '');
    return { status: res.status, url: current, body, hops };
  }
  throw new Error(`too many redirects for ${url}`);
}

test('every internal link on every built page resolves (no 404s, anchors exist)', async () => {
  const targets = new Map(); // href -> pages using it
  const add = (raw, page) => {
    if (!raw) return;
    const value = raw.trim();
    if (!value || /^(mailto:|tel:|javascript:|data:|sms:)/i.test(value)) return;
    const base = page === 'index.html' ? `${origin}/` : `${origin}/${page}`;
    let u;
    try {
      u = new URL(value, base);
    } catch {
      return;
    }
    if (u.origin !== origin) return; // other sites (Calendly, WhatsApp, canonical URLs) are not ours to serve
    const key = u.href;
    if (!targets.has(key)) targets.set(key, new Set());
    targets.get(key).add(page);
  };
  for (const page of builtPages()) {
    for (const t of tagsOf(readBuilt(page))) {
      if (t.closing) continue;
      if (t.name === 'a' || t.name === 'link') add(t.attrs.href, page);
      if (t.name === 'script' || t.name === 'img' || t.name === 'source') add(t.attrs.src, page);
      if (t.attrs.srcset) for (const c of parseSrcset(t.attrs.srcset)) add(c.url, page);
    }
    // Links built by page scripts (thank-you.html picks its buttons in JS).
    for (const m of readBuilt(page).matchAll(/\[\s*'(\/[^']*)'\s*,/g)) add(m[1], page);
  }
  // Old and short addresses that must keep working.
  for (const extra of ['/pricing.html', '/pricing', '/pricing.html#google-ads', '/services', '/growth-check', '/hub', '/calculator', '/services.html#plans']) add(extra, 'index.html');

  const failures = [];
  const pageCache = new Map();
  for (const [href, pages] of targets) {
    const result = await resolve(href);
    if (result.status !== 200) {
      failures.push(`${href} -> ${result.status} (from ${[...pages].join(', ')})`);
      continue;
    }
    const hash = decodeURIComponent(result.url.hash.slice(1));
    if (hash) {
      const doc = pageCache.get(result.url.pathname) ?? result.body;
      pageCache.set(result.url.pathname, doc);
      const ids = new Set(tagsOf(doc).filter((t) => !t.closing && (t.attrs.id || t.attrs.name)).map((t) => t.attrs.id || t.attrs.name));
      if (!ids.has(hash)) failures.push(`${href}: no #${hash} on ${result.url.pathname} (from ${[...pages].join(', ')})`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.ok(targets.size > 40, `checked ${targets.size} internal links`);

  // The old pricing page lands on the plans, with a permanent redirect.
  const pricing = await resolve(`${origin}/pricing.html`);
  assert.deepEqual(pricing.hops, ['308 /services.html#plans']);
  assert.equal(pricing.url.pathname + pricing.url.hash, '/services.html#plans');
});

// ---------------------------------------------------------------------------
// In a real browser
// ---------------------------------------------------------------------------
test('phone menu shows exactly Services, Our Work, Free Audit, About, Book a call, Client login', async () => {
  const { context, page, errors } = await openPage(PHONE);
  try {
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    assert.deepEqual(await visibleMenuItems(page), [], 'menu closed at first');
    assert.equal(await page.isVisible('.nav-actions'), false, 'desktop Client login/Book a call hidden on phones');
    await page.click('#mobile-menu');
    await page.waitForFunction(() => document.getElementById('site-nav').classList.contains('active'));
    await page.waitForTimeout(500); // the menu slides open
    assert.deepEqual(await visibleMenuItems(page), MENU);
    assert.equal(await page.getAttribute('#mobile-menu', 'aria-expanded'), 'true');
    await shot(page, 'menu-open-390');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('site-nav').classList.contains('active'));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('desktop menu: four links, then Client login next to Book a call', async () => {
  const { context, page, errors } = await openPage(DESKTOP);
  try {
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    assert.deepEqual(await visibleMenuItems(page), ['Services', 'Our Work', 'Free Audit', 'About']);
    const actions = await page.$$eval('.nav-actions a', (links) => links.map((a) => a.textContent.trim()));
    assert.deepEqual(actions, ['Client login', 'Book a call']);
    assert.equal(await page.isVisible('#mobile-menu'), false);
    await shot(page, 'menu-1280');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Free Growth Check runs end to end on tuskertees.com (phone and desktop)', { timeout: 240000 }, async () => {
  for (const viewport of [PHONE, DESKTOP]) {
    const { context, page, errors } = await openPage(viewport);
    try {
      await page.goto(`${origin}/growth-check`, { waitUntil: 'load' });
      assert.equal(await page.isVisible('#gc-what'), true);
      await shot(page, `growth-check-empty-${viewport.width}`, { fullPage: true });

      await page.fill('#gc-business', 'Tusker Tees');
      await page.fill('#gc-url', 'tuskertees.com');
      await page.click('#gc-form button[type="submit"]');
      await page.waitForSelector('#gc-loading:not([hidden])');
      assert.match(await page.textContent('#gc-loading'), /up to 30 seconds/);
      await page.waitForSelector('#gc-result:not([hidden]), #gc-error:not([hidden])', { timeout: 90000 });
      assert.equal(await page.isVisible('#gc-error'), false, `error shown: ${await page.textContent('#gc-error-text')}`);

      const score = (await page.textContent('#gc-score')).trim();
      assert.match(score, /^\d{1,3}$/);
      assert.ok(Number(score) <= 100);
      assert.match((await page.textContent('#gc-grade')).trim(), /^[ABCDF]$/);
      assert.equal((await page.textContent('#gc-result-business')).trim(), 'Tusker Tees');
      const fixes = await page.$$eval('#gc-fixes li', (items) => items.map((li) => li.textContent.trim()));
      assert.ok(fixes.length >= 1 && fixes.length <= 3, `${fixes.length} fixes`);
      assert.ok(await page.isVisible('#gc-fixes li'));
      const groups = await page.$$eval('#gc-groups .gc-group h3', (h) => h.map((x) => x.textContent.trim()));
      assert.deepEqual(groups, ['Speed', 'Mobile & SEO basics', 'Getting leads', 'Tracking']);
      assert.ok((await page.$$('#gc-groups .gc-item')).length === 16);
      if (!process.env.PAGESPEED_API_KEY) {
        assert.equal(await page.isVisible('#gc-speed-note'), true, 'no PageSpeed key: the plain-words note shows');
      }
      assert.ok(await page.isVisible('.gc-soon'));

      const wa = await page.getAttribute('#gc-wa', 'href');
      assert.ok(wa.startsWith('https://wa.me/919949932140?text='), wa);
      const message = decodeURIComponent(wa.slice(wa.indexOf('?text=') + 6));
      assert.match(message, /tuskertees\.com/);
      assert.match(message, new RegExp(`Score: ${score}/100`));
      assert.match(message, /Top fixes:\n1\. /);
      assert.ok(await page.isVisible('#gc-wa'));
      assert.match((await page.textContent('#gc-wa')).trim(), /Send me these fixes on WhatsApp/);
      assert.ok(await page.isVisible('.gc-cta a[href="https://calendly.com/digitaldominant/30min"]'));

      await shot(page, `growth-check-result-${viewport.width}`, { fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test('Growth Check shows plain-words errors (private address, typo)', async () => {
  const { context, page, errors } = await openPage(DESKTOP);
  try {
    await page.goto(`${origin}/growth-check`, { waitUntil: 'load' });
    await page.click('#gc-form button[type="submit"]');
    assert.match(await page.textContent('#gc-form-error'), /business name/);
    await page.fill('#gc-business', 'Test');
    await page.fill('#gc-url', 'http://192.168.1.1/');
    // The API answers 400 here on purpose; that one response is not a page error.
    const response = page.waitForResponse((r) => r.url().endsWith('/api/growth-check'));
    await page.click('#gc-form button[type="submit"]');
    assert.equal((await response).status(), 400);
    await page.waitForSelector('#gc-error:not([hidden])');
    assert.match(await page.textContent('#gc-error-text'), /private or internal network/);
    assert.deepEqual(errors.filter((e) => !/HTTP 400: .*\/api\/growth-check/.test(e) && !/status of 400/.test(e)), []);
  } finally {
    await context.close();
  }
});

test('every page loads in the browser without errors; screenshots', { timeout: 240000 }, async () => {
  for (const viewport of [DESKTOP, PHONE]) {
    const { context, page, errors } = await openPage(viewport);
    try {
      for (const file of builtPages()) {
        if (file === 'pricing.html' || file === 'portfolio.html' || file === 'testimonials.html') continue; // redirect pages
        const pathName = file === 'index.html' ? '/' : `/${file}`;
        await page.goto(`${origin}${pathName}`, { waitUntil: 'load' });
        await page.waitForTimeout(150);
        assert.deepEqual(errors, [], `${file} at ${viewport.width}px`);
      }
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await shot(page, `home-${viewport.width}`, { fullPage: true });
      if (SHOTS) {
        // The fixed menu would sit on top of the footer in an element shot.
        const hideMenu = await page.addStyleTag({ content: '.navbar{visibility:hidden!important}' });
        await page.locator('#site-footer').screenshot({ path: path.join(SHOTS, `footer-${viewport.width}.png`) });
        await hideMenu.evaluate((node) => node.remove());
      }
      await page.goto(`${origin}/services.html`, { waitUntil: 'load' });
      await shot(page, `services-${viewport.width}`, { fullPage: true });
      await page.goto(`${origin}/pricing.html`, { waitUntil: 'load' });
      assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, '/services.html#plans');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});
