// Review fixes for the Growth Check, each one taken from a real small-business
// site that the first version got wrong (checked against the same page in a
// real phone browser), plus the regexes a hostile page could make crawl.
// Offline: snippets of the real markup, no network.
//   node tests/growth-check-accuracy.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeHtml,
  evaluateChecks,
  findTracking,
  parseSrcset,
  pickSrcsetCandidate,
  runGrowthCheck,
  slotWidth,
  viewportFitsPhones,
} from '../api/_lib/growth-check-core.js';

const SITE = new URL('https://smithplumbing.example/');
const noImages = { found: 0, checked: 0, measured: 0, totalBytes: 0, heaviest: [], broken: 0 };
const noSpeed = { available: false, reason: 'no_key' };
const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
// Enough visible text that the page doesn't count as drawn by JavaScript.
const TEXT = `<p>${'We fix leaks, drains and water heaters across Austin. '.repeat(6)}</p>`;

function checksFor(html, url = SITE) {
  const facts = analyzeHtml(html, url);
  const page = { html, finalUrl: url, redirects: [], htmlBytes: Buffer.byteLength(html), truncated: false };
  return Object.fromEntries(evaluateChecks({ facts, page, images: noImages, speed: noSpeed }).map((c) => [c.id, c]));
}

function respond(status, body = '', headers = { 'content-type': 'text/html; charset=utf-8' }) {
  return { status, headers, body: Buffer.from(body), bytes: Buffer.byteLength(body), truncated: false };
}

// ---------------------------------------------------------------------------
// Hostile pages: every regex over page content must stay linear
// ---------------------------------------------------------------------------
test('regexes stay fast on pages built to make them backtrack', () => {
  const big = 1_800_000;
  const nasty = {
    'elfsight.com repeated (was minutes)': `<body>${'elfsight.com'.repeat(big / 12)}</body>`,
    'srcset descriptor of digits (was quadratic)': `<img srcset="a.jpg ${'1'.repeat(big)}">`,
    'srcset descriptor of dots (was quadratic)': `<img srcset="a.jpg ${'.'.repeat(big)}">`,
    'srcset URL ending in commas (was quadratic)': `<img srcset="x${','.repeat(big)}y,">`,
    'script tel: fragments': '"tel:+1(((((((((((((((((('.repeat(big / 25),
    'escaped Google ids': '"G-ABCDEFGH\\'.repeat(big / 12),
    'Shopify pixel config fragments': 'pixel_type\\\\\\"  :  '.repeat(big / 20),
    'sizes with deep brackets': `<img srcset="a.jpg 100w, b.jpg 900w" sizes="${'('.repeat(5000)}">`,
  };
  for (const [label, html] of Object.entries(nasty)) {
    const started = Date.now();
    analyzeHtml(html, SITE);
    const ms = Date.now() - started;
    assert.ok(ms < 1500, `${label}: took ${ms} ms`);
  }
});

// ---------------------------------------------------------------------------
// Forms and booking tools
// ---------------------------------------------------------------------------
test('an Elfsight widget is not a contact form (its platform.js only contains the word "form")', () => {
  const c = checksFor(`<h1>Baker Plumbing</h1>${TEXT}<script src="https://static.elfsight.com/platform/platform.js" async></script><div class="elfsight-app-1b2c"></div>`);
  assert.equal(c.contact_form.status, 'fail');
});

test('online booking tools and Squarespace form blocks count as a way to ask for a quote', () => {
  const serviceTitan = checksFor(`<h1>Reliant</h1>${TEXT}<script src="https://embed.scheduler.servicetitan.com/scheduler-v1.js"></script>`);
  assert.equal(serviceTitan.contact_form.status, 'pass');
  assert.equal(serviceTitan.contact_form.detail, 'Found a ServiceTitan booking form.');
  // The same script written into escaped JSON by a page builder.
  assert.equal(checksFor(`${TEXT}<script>var c={"src":"https:\\/\\/embed.scheduler.servicetitan.com\\/scheduler\\u002Dv1.js"}</script>`).contact_form.status, 'pass');
  const squarespace = checksFor(`${TEXT}<div class="sqs-block website-component-block sqs-block-form form-block" data-sqsp-block="form"></div>`);
  assert.equal(squarespace.contact_form.status, 'pass');
  assert.equal(squarespace.contact_form.detail, 'Found a Squarespace form.');
  assert.equal(checksFor(`${TEXT}<a href="https://clienthub.getjobber.com/booking/55810b9d">Book online</a>`).contact_form.status, 'pass');
  // A customer-login link to the same software is not a booking form.
  assert.equal(checksFor(`${TEXT}<a href="https://reliant.myservicetitan.com/login">Log in</a>`).contact_form.status, 'fail');
});

// ---------------------------------------------------------------------------
// Tap-to-call drawn by scripts
// ---------------------------------------------------------------------------
test('a tap-to-call link drawn by a script counts; a printed "Tel:" label does not', () => {
  const json = checksFor(`<h1>Acme</h1>${TEXT}<script>window.__MENU__={"items":[{"label":"Call","href":"tel:+15125550100"}]}</script>`);
  assert.equal(json.click_to_call.status, 'pass');
  assert.equal(json.click_to_call.detail, 'Found: +15125550100.');
  const escaped = checksFor(`${TEXT}<script>self.__next_f.push([1,"{\\"href\\":\\"tel:+1 (512) 555-0100\\"}"])</script>`);
  assert.equal(escaped.click_to_call.status, 'pass');
  assert.equal(checksFor(`${TEXT}<p>Tel: 512 555 0100</p>`).click_to_call.status, 'fail');
  assert.equal(checksFor(`${TEXT}<script>var t = "tel:" + phone;</script>`).click_to_call.status, 'fail');
  assert.equal(checksFor(`${TEXT}<!-- <a href="tel:+15125550100">Call</a> -->`).click_to_call.status, 'fail', 'commented out');
});

test('Squarespace\'s phone "Call" bar counts when it is switched on', () => {
  const settings = (on) =>
    `${TEXT}<script>Static.SQUARESPACE_CONTEXT = {"website":{"contactPhoneNumber":"773.802.6351"},"mobileInfoBarSettings":{"isContactEmailEnabled":false,"isContactPhoneNumberEnabled":${on}}};</script>`;
  const on = checksFor(settings(true));
  assert.equal(on.click_to_call.status, 'pass');
  assert.equal(on.click_to_call.detail, 'Found: 773.802.6351.');
  assert.equal(checksFor(settings(false)).click_to_call.status, 'fail');
});

// ---------------------------------------------------------------------------
// Tracking hidden in config, other tag managers
// ---------------------------------------------------------------------------
test('Shopify: Google Analytics and the Meta Pixel inside the web-pixel config are found', () => {
  const shopify =
    '<script id="web-pixels-manager-setup">(function(){var webPixelsConfigList=[{"id":"301924400","configuration":"{\\"config\\":\\"{\\\\\\"google_tag_ids\\\\\\":[\\\\\\"G-CP4PB7BCB1\\\\\\"],\\\\\\"gtag_events\\\\\\":[]}\\"}"},' +
    '{"id":"694190128","configuration":"{\\"pixel_id\\":\\"463908982381608\\",\\"pixel_type\\":\\"facebook_pixel\\"}"}];})();</script>';
  const t = findTracking(shopify);
  assert.deepEqual(t.ga4, ['G-CP4PB7BCB1']);
  assert.equal(t.hasAnalytics, true);
  assert.equal(t.hasMetaPixel, true);
  const c = checksFor(`${TEXT}${shopify}`);
  assert.equal(c.analytics.status, 'pass');
  assert.equal(c.meta_pixel.status, 'pass');
  // The plain gtag snippet still needs a quote or &/space after the id.
  assert.deepEqual(findTracking('<p>Model G-SHOCKWATCH5 in stock</p>').ga4, []);
});

test('a site run through Adobe Launch has a tag manager; the Ads tag and Pixel may be inside it', () => {
  const html = `${TEXT}<script>window.cfg={"launch":"\\/\\/assets.adobedtm.com\\/33a48fe0d360\\/60a2dcc81eaa\\/launch\\u002D3116f811f06d.min.js"}</script>`;
  const c = checksFor(html);
  assert.equal(c.analytics.status, 'pass');
  assert.equal(c.analytics.detail, 'Found a tag manager (Adobe Launch).');
  assert.equal(c.google_ads_tag.status, 'warn');
  assert.match(c.google_ads_tag.detail, /inside your tag manager \(Adobe Launch\)/);
  assert.equal(c.meta_pixel.status, 'warn');
  // Google Tag Manager keeps its original wording.
  const gtm = checksFor(`${TEXT}<script src="https://www.googletagmanager.com/gtm.js?id=GTM-AB12CD3"></script>`);
  assert.equal(gtm.google_ads_tag.detail, 'Not on the page itself. It may be inside Tag Manager, which we can’t see into.');
});

// ---------------------------------------------------------------------------
// Wix: tracking codes arrive after the page loads
// ---------------------------------------------------------------------------
const WIX_PAGE = `<!DOCTYPE html><html><head><meta name="generator" content="Wix.com Website Builder"><meta name="viewport" content="width=320, user-scalable=yes">
<title>Plumbing Services | Tim Dean Plumbing</title></head><body><h1>Plumbing Services You Can Trust</h1>${TEXT}
<script type="application/json" id="wix-viewer-model">{"site":{"metaSiteId":"a7a6296a-ad34-41d0-afd6-c81e2d0ac173","siteId":"5be511e1-b28f-4433-9d16-318d034017e6"}}</script>
<a href="tel:+1-610-942-3865">Call</a></body></html>`;

test('Wix: the tracking codes in the site\'s tag list are found (the same request a browser makes)', async () => {
  const requests = [];
  const transport = async (url, opts) => {
    requests.push(`${opts.method} ${url.href}`);
    if (url.pathname === '/') return respond(200, WIX_PAGE);
    if (url.pathname.startsWith('/_api/tag-manager/')) {
      const tags = {
        tags: [
          { name: 'gtag.widget.title', content: '<script async src="https://www.googletagmanager.com/gtag/js?id=AW-644712084"></script><script>gtag(\'config\', \'AW-644712084\');</script>' },
          { name: 'Google Tag Manager', content: "<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-T4DJRNKG');</script>" },
        ],
        errors: [],
      };
      return respond(200, JSON.stringify(tags), { 'content-type': 'application/json' });
    }
    return respond(404, '');
  };
  const report = await runGrowthCheck({ url: 'timdeanplumbing.example', business: 'Tim Dean' }, { deps: { resolve: PUBLIC, transport } });
  assert.equal(report.ok, true, report.error);
  assert.ok(
    requests.includes('GET https://timdeanplumbing.example/_api/tag-manager/api/v1/tags/sites/a7a6296a-ad34-41d0-afd6-c81e2d0ac173?wixSite=false&htmlsiteId=5be511e1-b28f-4433-9d16-318d034017e6'),
    requests.join('\n'),
  );
  const c = Object.fromEntries(report.groups.flatMap((g) => g.checks).map((x) => [x.id, x]));
  assert.equal(c.analytics.status, 'pass');
  assert.match(c.analytics.detail, /GTM-T4DJRNKG/);
  assert.equal(c.google_ads_tag.status, 'pass');
  assert.match(c.google_ads_tag.detail, /AW-644712084/);
  assert.equal(c.meta_pixel.status, 'warn', 'may be inside Tag Manager');
  assert.equal(c.viewport.status, 'pass', "Wix's width=320 mobile viewport fits phones");
});

test('Wix: when the tag list can\'t be read, tracking is "not checked", never "missing"', async () => {
  const transport = async (url) => (url.pathname === '/' ? respond(200, WIX_PAGE) : respond(500, 'oops'));
  const report = await runGrowthCheck({ url: 'timdeanplumbing.example' }, { deps: { resolve: PUBLIC, transport } });
  assert.equal(report.ok, true, report.error);
  const c = Object.fromEntries(report.groups.flatMap((g) => g.checks).map((x) => [x.id, x]));
  for (const id of ['analytics', 'google_ads_tag', 'meta_pixel']) {
    assert.equal(c[id].status, 'skipped', id);
    assert.match(c[id].detail, /^Wix adds tracking codes after the page loads/);
  }
  assert.ok(!report.topFixes.some((f) => ['analytics', 'google_ads_tag', 'meta_pixel'].includes(f.id)));
});

test('Wix: an empty tag list is a real "no tracking"', async () => {
  const transport = async (url) =>
    url.pathname === '/' ? respond(200, WIX_PAGE) : respond(200, '{"tags":[],"errors":[],"config":{}}', { 'content-type': 'application/json' });
  const report = await runGrowthCheck({ url: 'plumbgurus.example' }, { deps: { resolve: PUBLIC, transport } });
  const c = Object.fromEntries(report.groups.flatMap((g) => g.checks).map((x) => [x.id, x]));
  assert.equal(c.analytics.status, 'fail');
  assert.equal(c.meta_pixel.status, 'fail');
});

test('Wix: the tag list request goes through the same guarded fetch (checked, pinned address; redirects re-checked)', async () => {
  const tagCalls = [];
  const transport = async (url, opts) => {
    if (url.pathname === '/') return respond(200, WIX_PAGE);
    if (url.hostname === 'metadata.internal.example') return respond(200, '{"tags":[{"content":"GTM-EVIL123"}]}');
    tagCalls.push(opts.addresses);
    // A tag list that redirects to an internal address must not be followed.
    return { ...respond(302, ''), headers: { location: 'http://169.254.169.254/latest/meta-data/' } };
  };
  const report = await runGrowthCheck({ url: 'wix-site.example' }, { deps: { resolve: PUBLIC, transport } });
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(tagCalls, [[{ address: '93.184.216.34', family: 4 }]], 'one request, pinned to the checked public address');
  const analytics = report.groups.flatMap((g) => g.checks).find((c) => c.id === 'analytics');
  assert.equal(analytics.status, 'skipped', 'the refused redirect means the tags could not be read');
});

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------
test('viewport: phone widths and initial-scale fit; a desktop width does not', () => {
  assert.equal(viewportFitsPhones('width=device-width, initial-scale=1'), true);
  assert.equal(viewportFitsPhones('width=320, user-scalable=yes'), true, 'Wix mobile sites');
  assert.equal(viewportFitsPhones('initial-scale=1.0'), true);
  assert.equal(viewportFitsPhones('width=1024'), false);
  assert.equal(viewportFitsPhones('width=980, initial-scale=1'), false);
  assert.equal(viewportFitsPhones('user-scalable=no'), false);
  assert.equal(checksFor(`<meta name="viewport" content="width=1024">${TEXT}`).viewport.status, 'warn');
});

// ---------------------------------------------------------------------------
// Image weight: the size a phone downloads
// ---------------------------------------------------------------------------
test('images: srcset beats src, and sizes decides which candidate a phone downloads', () => {
  // Shopify: src is the 2400px original; a phone shows the card at 39vw.
  const shopify = analyzeHtml(
    '<img src="//shop.example/cdn/shop/files/bike.jpg?width=2400" srcset="//shop.example/cdn/shop/files/bike.jpg?width=165 165w, //shop.example/cdn/shop/files/bike.jpg?width=360 360w, //shop.example/cdn/shop/files/bike.jpg?width=533 533w, //shop.example/cdn/shop/files/bike.jpg?width=1066 1066w, //shop.example/cdn/shop/files/bike.jpg?width=2400 2400w" sizes="(min-width: 769px) 20vw, 39vw">',
    SITE,
  );
  assert.deepEqual(shopify.images.map((i) => i.url), ['https://shop.example/cdn/shop/files/bike.jpg?width=533']);
  // Lazy-loader: placeholder in srcset, the real list in data-srcset.
  const lazy = analyzeHtml(
    '<img src="data:image/gif;base64,R0lGOD" srcset="data:image/svg+xml,%3Csvg%3E" data-srcset="/a-768.jpg 768w, /a-1200.jpg 1200w, /a-2000.jpg 2000w">',
    SITE,
  );
  assert.deepEqual(lazy.images.map((i) => i.url), ['https://smithplumbing.example/a-1200.jpg']);
  // No srcset: src as before.
  assert.deepEqual(analyzeHtml('<img src="/plain.jpg">', SITE).images.map((i) => i.url), ['https://smithplumbing.example/plain.jpg']);
});

test('sizes: the common forms, and anything unreadable means the full phone width', () => {
  assert.equal(slotWidth('(max-width: 300px) 100vw, 300px'), 300);
  assert.equal(slotWidth('(max-width: 768px) 100vw, 768px'), 390);
  assert.equal(slotWidth('auto, 400px'), 400);
  assert.equal(slotWidth('(min-width: 1024px) 22rem, (min-width: 640px) 45vw, 90vw'), 351);
  assert.equal(slotWidth('calc((100vw - 35px) / 2)'), 177.5);
  assert.equal(slotWidth('(min-width: 750px) calc((100vw - 10rem) / 2), calc(100vw - 3rem)'), 342);
  assert.equal(slotWidth('(max-width: 47.9375em) 50vw, 25vw'), 195);
  assert.equal(slotWidth(''), 390);
  assert.equal(slotWidth('min(100vw, 640px)'), 390);
  assert.equal(slotWidth('(orientation: portrait) 50vw, 80vw'), 312);
  // Chrome-like pick at 3x: the smallest sharp-enough candidate, or the one just below it.
  const list = parseSrcset('a-640.jpg 640w, a-828.jpg 828w, a-1080.jpg 1080w, a-1920.jpg 1920w');
  assert.equal(pickSrcsetCandidate(list, '90vw'), 'a-1080.jpg');
  assert.equal(pickSrcsetCandidate(list, '100px'), 'a-640.jpg');
  assert.equal(pickSrcsetCandidate(parseSrcset('logo.png 1x, logo@2x.png 2x'), ''), 'logo@2x.png');
});

// ---------------------------------------------------------------------------
// Pages drawn by JavaScript
// ---------------------------------------------------------------------------
test('a page drawn by JavaScript: content checks are "not checked", not "missing"', () => {
  const shell = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acme Dental Studio | Dentist in Denver</title>
<script src="/assets/index-4f2a.js"></script><script>window.__STATE__=${JSON.stringify({ pad: 'x'.repeat(6000) })}</script></head><body><div id="root"></div></body></html>`;
  const c = checksFor(shell);
  for (const id of ['h1', 'click_to_call', 'contact_form', 'whatsapp']) {
    assert.equal(c[id].status, 'skipped', id);
    assert.match(c[id].detail, /drawn by JavaScript/);
  }
  assert.equal(c.title.status, 'pass', 'what is in the HTML is still checked');
  assert.equal(c.meta_description.status, 'fail');
  // A short static page with no scripts is what it is: missing stays missing.
  const staticPage = `<html><head><title>Coming soon</title><style>${'.a{color:red}'.repeat(600)}</style></head><body><p>Coming soon.</p></body></html>`;
  const s = checksFor(staticPage);
  assert.equal(s.h1.status, 'fail');
  assert.equal(s.click_to_call.status, 'fail');
});

// ---------------------------------------------------------------------------
// Bare domains whose HTTPS doesn't work, and firewalls that answer 200
// ---------------------------------------------------------------------------
test('a bare domain whose HTTPS hangs or errors is checked over http://', async () => {
  const html = `<html><head><title>Joe's Plumbing | Austin TX</title></head><body><h1>Joe's Plumbing</h1>${TEXT}</body></html>`;
  for (const [label, httpsAnswer] of [
    ['no answer', async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }],
    ['server error', async () => respond(503, 'Service Unavailable')],
  ]) {
    const transport = async (url, opts) => (url.protocol === 'https:' ? httpsAnswer(url, opts) : respond(200, html));
    const report = await runGrowthCheck({ url: 'oldplumber.example' }, { deps: { resolve: PUBLIC, transport } });
    assert.equal(report.ok, true, `${label}: ${report.error}`);
    assert.equal(report.finalUrl, 'http://oldplumber.example/', label);
    const https = report.groups.flatMap((g) => g.checks).find((c) => c.id === 'https');
    assert.equal(https.status, 'fail', label);
  }
  // Blocked over HTTPS is not "no HTTPS": no fallback, the block is reported.
  const blocked = await runGrowthCheck(
    { url: 'oldplumber.example' },
    { deps: { resolve: PUBLIC, transport: async (url) => (url.protocol === 'https:' ? respond(403, 'denied') : respond(200, html)) } },
  );
  assert.equal(blocked.code, 'blocked');
  // Typed https:// on purpose: no fallback either.
  const typed = await runGrowthCheck(
    { url: 'https://oldplumber.example/' },
    { deps: { resolve: PUBLIC, transport: async (url) => (url.protocol === 'https:' ? respond(503, 'x') : respond(200, html)) } },
  );
  assert.equal(typed.code, 'server_error');
});

test('a firewall challenge page that answers 200 is reported as blocked, not checked', async () => {
  const walls = [
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cvId:"3"};</script></body></html>',
    '<html><head><title>You are being redirected...</title></head><body><script>var s={},u,c,U,r,i,l=0;sucuri_cloudproxy_js=\'\';</script></body></html>',
    '<html><head><META NAME="robots" CONTENT="noindex,nofollow"></head><body>Request unsuccessful. Incapsula incident ID: 123-456</body></html>',
  ];
  for (const wall of walls) {
    const report = await runGrowthCheck({ url: 'guarded.example' }, { deps: { resolve: PUBLIC, transport: async () => respond(200, wall) } });
    assert.equal(report.ok, false, wall.slice(0, 40));
    assert.equal(report.code, 'blocked');
    assert.match(report.error, /security challenge/);
  }
  // Cloudflare's bot script on a normal page is not a wall.
  const normal = `<html><head><title>Joe's Plumbing</title></head><body><h1>Joe's</h1>${TEXT}<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>`;
  const ok = await runGrowthCheck({ url: 'joes.example' }, { deps: { resolve: PUBLIC, transport: async () => respond(200, normal) } });
  assert.equal(ok.ok, true, ok.error);
});
