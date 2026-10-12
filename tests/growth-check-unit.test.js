// Unit tests for the Growth Check's reading, checks and scoring, on saved HTML
// fixtures. Offline: no DNS, no network.
//   node tests/growth-check-unit.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHECKS,
  GROUPS,
  analyzeHtml,
  cleanText,
  decodeEntities,
  evaluateChecks,
  findTracking,
  gradeFor,
  measureImages,
  parsePageSpeed,
  parseSrcset,
  runGrowthCheck,
  runPageSpeed,
  scanHtml,
  scoreChecks,
} from '../api/_lib/growth-check-core.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const SITE = new URL('https://smithroofing.example/');
const noImages = { found: 0, checked: 0, measured: 0, totalBytes: 0, heaviest: [], broken: 0 };
const noSpeed = { available: false, reason: 'no_key' };
const pageOf = (html, url = SITE, extra = {}) => ({
  html,
  finalUrl: url,
  redirects: [],
  htmlBytes: Buffer.byteLength(html),
  truncated: false,
  ...extra,
});
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

test('weights add up to 100 and every check sits in a known group', () => {
  assert.equal(CHECKS.reduce((sum, c) => sum + c.weight, 0), 100);
  const groupIds = new Set(GROUPS.map((g) => g.id));
  for (const c of CHECKS) assert.ok(groupIds.has(c.group), `${c.id} has group ${c.group}`);
  assert.deepEqual(GROUPS.map((g) => g.title), ['Speed', 'Mobile & SEO basics', 'Getting leads', 'Tracking']);
});

test('grades follow the documented boundaries', () => {
  const cases = [[100, 'A'], [90, 'A'], [89, 'B'], [80, 'B'], [79, 'C'], [70, 'C'], [69, 'D'], [60, 'D'], [59, 'F'], [0, 'F']];
  for (const [score, grade] of cases) assert.equal(gradeFor(score).grade, grade, `score ${score}`);
});

test('good site: reads everything the checks need', () => {
  const facts = analyzeHtml(fixture('good-site.html'), SITE);
  assert.equal(facts.title, 'Smith Roofing | Roof Repair & Replacement in Austin, TX', 'document title, not the SVG <title>');
  assert.match(facts.metaDescription, /^Smith Roofing repairs/);
  assert.match(facts.viewport, /width=device-width/);
  assert.deepEqual(facts.h1s, ['Roof repair in Austin, done right'], 'commented-out and script-string H1s are ignored');
  assert.deepEqual(facts.telLinks, ['+1-512-555-0100']);
  assert.equal(facts.whatsappLinks, 1);
  assert.equal(facts.og['og:title'], 'Smith Roofing, Austin TX');
  assert.ok(facts.og['og:image']);
  assert.ok(facts.jsonLdTypes.includes('RoofingContractor'));
  assert.deepEqual(
    facts.images.map((i) => i.url),
    [
      'https://smithroofing.example/img/hero.webp',
      'https://smithroofing.example/img/hero-bg.jpg',
      'https://smithroofing.example/img/lazy-team.jpg',
      'https://smithroofing.example/img/job-1080.jpg',
      'https://smithroofing.example/img/van.jpg',
    ],
    'preload, inline background, lazy data-src, srcset (nearest 1080w) and <picture>; no tracking pixel, no <style> urls',
  );
  assert.equal(facts.inlineImages, 1);
  const search = facts.forms.find((f) => f.search);
  const quote = facts.forms.find((f) => !f.search);
  assert.ok(search, 'search form is recognised');
  assert.equal(quote.fields, 3);
  assert.equal(quote.textareas, 1);
  assert.equal(quote.tels, 1);
  assert.deepEqual(facts.tracking.ga4, ['G-ABC1234XYZ']);
  assert.deepEqual(facts.tracking.ads, ['AW-123456789']);
  assert.equal(facts.tracking.hasMetaPixel, true);
  assert.deepEqual(facts.tracking.pixelIds, ['123456789012345']);
});

test('good site: every check passes, speed skipped, score 100 (A), no fixes', () => {
  const html = fixture('good-site.html');
  const facts = analyzeHtml(html, SITE);
  const images = { found: 5, checked: 5, measured: 5, totalBytes: 600 * 1024, heaviest: [{ name: 'hero.webp', bytes: 250 * 1024 }], broken: 0 };
  const checks = evaluateChecks({ facts, page: pageOf(html), images, speed: noSpeed });
  const c = byId(checks);
  assert.equal(c.speed_score.status, 'skipped');
  assert.equal(c.speed_score.detail, 'Speed test unavailable right now. We checked your image weight instead.');
  for (const check of checks.filter((x) => x.id !== 'speed_score')) assert.equal(check.status, 'pass', `${check.id}: ${check.detail}`);
  const scored = scoreChecks(checks);
  assert.equal(scored.possible, 86, 'the skipped speed check (14) is left out');
  assert.equal(scored.score, 100);
  assert.equal(scored.grade, 'A');
  assert.deepEqual(scored.topFixes, []);
});

test('good site with a slow Google speed score: proportional points, speed is fix #1', () => {
  const html = fixture('good-site.html');
  const facts = analyzeHtml(html, SITE);
  const speed = parsePageSpeed(JSON.parse(fixture('pagespeed-sample.json')));
  const checks = evaluateChecks({ facts, page: pageOf(html), images: noImages, speed });
  const c = byId(checks);
  assert.equal(c.speed_score.status, 'warn');
  assert.equal(c.speed_score.credit, 0.54);
  assert.match(c.speed_score.detail, /54\/100/);
  assert.match(c.speed_score.detail, /4\.1 s/);
  assert.match(c.speed_score.detail, /0\.12/);
  assert.match(c.speed_score.detail, /3\.3 MB/);
  const scored = scoreChecks(checks);
  assert.equal(scored.possible, 100);
  assert.equal(scored.score, Math.round(86 + 14 * 0.54)); // 94
  assert.equal(scored.topFixes[0].id, 'speed_score');
});

test('bare site on http: fails the basics; fixes are calls, HTTPS, mobile', () => {
  const html = fixture('bare-site.html');
  const url = new URL('http://joesplumbing.example/');
  const facts = analyzeHtml(html, url);
  const checks = evaluateChecks({ facts, page: pageOf(html, url), images: noImages, speed: noSpeed });
  const c = byId(checks);
  for (const id of ['https', 'viewport', 'title', 'meta_description', 'h1', 'structured_data', 'open_graph', 'click_to_call', 'contact_form', 'whatsapp', 'analytics', 'google_ads_tag', 'meta_pixel']) {
    assert.equal(c[id].status, 'fail', id);
    assert.ok(c[id].fix, `${id} has a plain-words fix`);
  }
  assert.equal(c.image_weight.status, 'pass');
  assert.equal(c.html_size.status, 'pass');
  const scored = scoreChecks(checks);
  assert.equal(scored.score, Math.round((14 / 86) * 100));
  assert.equal(scored.grade, 'F');
  assert.deepEqual(scored.topFixes.map((f) => f.id), ['click_to_call', 'https', 'viewport']);
  for (const fix of scored.topFixes) assert.ok(fix.text.length > 20 && !/[<>]/.test(fix.text));
});

test('mixed site: warnings for half-done basics, GTM hides the tags, junk forms ignored', () => {
  const html = fixture('mixed-site.html');
  const url = new URL('https://example-shop.test/');
  const facts = analyzeHtml(html, url);
  const c = byId(evaluateChecks({ facts, page: pageOf(html, url), images: noImages, speed: noSpeed }));
  assert.equal(c.viewport.status, 'warn');
  assert.equal(c.title.status, 'warn');
  assert.match(c.title.detail, /characters; Google cuts it off/);
  assert.equal(c.meta_description.status, 'warn');
  assert.equal(c.h1.status, 'warn');
  assert.match(c.h1.detail, /^2 main headlines/);
  assert.equal(c.structured_data.status, 'warn', 'WebSite schema is not business details');
  assert.equal(c.open_graph.status, 'warn');
  assert.equal(c.click_to_call.status, 'fail', 'an empty tel: link does not count');
  assert.equal(c.contact_form.status, 'warn', 'search, login and cart forms are ignored; only one-box sign-ups left');
  assert.equal(c.whatsapp.status, 'pass');
  assert.equal(c.analytics.status, 'pass');
  assert.match(c.analytics.detail, /GTM-AB12CD3/);
  assert.equal(c.google_ads_tag.status, 'warn');
  assert.equal(c.meta_pixel.status, 'warn');
  assert.deepEqual(
    facts.images.map((i) => i.url),
    [
      'https://cdn.example-shop.test/assets/photos/truck.jpg',
      'https://res.cloudinary.test/demo/image/upload/w_1000,h_750,c_fill/sample.jpg',
      'https://cdn.example-shop.test/bg/pattern.png',
    ],
    '<base href> is respected, srcset URLs with commas survive, the tracking pixel is dropped',
  );
});

test('gtag.js with only a Google Ads id is not Analytics', () => {
  const adsOnly = findTracking(`<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18459746528"></script><script>gtag('config','AW-18459746528')</script>`);
  assert.equal(adsOnly.hasAnalytics, false);
  assert.deepEqual(adsOnly.ads, ['AW-18459746528']);
  assert.equal(findTracking(`<script src="https://www.googletagmanager.com/gtag/js?id=G-XYZ12345"></script>`).hasAnalytics, true);
  assert.equal(findTracking(`<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"></script>`).hasTagManager, true);
  assert.equal(findTracking('<p>nothing here</p>').hasMetaPixel, false);
});

test('a form embedded from a form builder counts as a contact form', () => {
  const html = '<html><body><h1>Hi</h1><iframe src="https://form.jotform.com/123456"></iframe></body></html>';
  const facts = analyzeHtml(html, SITE);
  const c = byId(evaluateChecks({ facts, page: pageOf(html), images: noImages, speed: noSpeed }));
  assert.equal(c.contact_form.status, 'pass');
  assert.match(c.contact_form.detail, /Jotform/);
});

test('page code size thresholds', () => {
  const facts = analyzeHtml('<title>x</title>', SITE);
  const size = (bytes, truncated = false) =>
    byId(evaluateChecks({ facts, page: pageOf('', SITE, { htmlBytes: bytes, truncated }), images: noImages, speed: noSpeed })).html_size.status;
  assert.equal(size(120 * 1024), 'pass');
  assert.equal(size(500 * 1024), 'warn');
  assert.equal(size(900 * 1024), 'fail');
  assert.equal(size(2 * 1024 * 1024, true), 'fail');
});

test('image weight: pass under 1.5 MB, warn to 3 MB, fail above, heaviest files named', () => {
  const facts = analyzeHtml('<title>x</title>', SITE);
  const check = (images) => byId(evaluateChecks({ facts, page: pageOf(''), images, speed: noSpeed })).image_weight;
  const base = { found: 30, checked: 25, measured: 25, broken: 0 };
  assert.equal(check({ ...base, totalBytes: 900 * 1024, heaviest: [] }).status, 'pass');
  assert.equal(check({ ...base, totalBytes: 2 * 1024 * 1024, heaviest: [] }).status, 'warn');
  const heavy = check({
    ...base,
    totalBytes: 5 * 1024 * 1024,
    heaviest: [
      { name: 'hero.png', bytes: 2.4 * 1024 * 1024 },
      { name: 'team.jpg', bytes: 900 * 1024 },
      { name: 'icon.png', bytes: 20 * 1024 },
    ],
  });
  assert.equal(heavy.status, 'fail');
  assert.match(heavy.detail, /at least 5\.0 MB \(we weighed the first 25 of 30\)/);
  assert.match(heavy.detail, /hero\.png \(2\.4 MB\), team\.jpg \(900 KB\)\./);
  assert.doesNotMatch(heavy.detail, /icon\.png/, 'small files are not called heavy');
  assert.match(heavy.fix, /starting with hero\.png/);
  assert.equal(check({ ...base, found: 3, checked: 3, measured: 0, totalBytes: 0, heaviest: [] }).status, 'skipped');
});

test('measureImages: HEAD, range fallback, unknown sizes, 25-image cap', async () => {
  const sizes = new Map([
    ['/a.jpg', { head: { status: 200, length: 1000 } }],
    ['/b.jpg', { head: { status: 405 }, range: { status: 206, contentRange: 'bytes 0-0/250000' } }],
    ['/c.jpg', { head: { status: 200 }, range: { status: 200, length: 3000000 } }],
    ['/d.jpg', { head: { status: 200 }, range: { status: 200 } }],
    ['/gone.jpg', { head: { status: 404 } }],
  ]);
  const calls = [];
  const transport = async (url, opts) => {
    calls.push(`${opts.method} ${url.pathname}`);
    const entry = sizes.get(url.pathname) || { head: { status: 200, length: 10 } };
    if (opts.method === 'HEAD') {
      const h = entry.head;
      return { status: h.status, headers: h.length ? { 'content-length': String(h.length) } : {}, body: Buffer.alloc(0), bytes: 0, truncated: false };
    }
    assert.equal(opts.headers.range, 'bytes=0-0');
    const r = entry.range || { status: 404 };
    const headers = {};
    if (r.length) headers['content-length'] = String(r.length);
    if (r.contentRange) headers['content-range'] = r.contentRange;
    return { status: r.status, headers, body: Buffer.alloc(0), bytes: 0, truncated: false };
  };
  const deps = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport };
  const images = ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg', '/gone.jpg'].map((p) => ({ url: `https://img.example${p}` }));
  const result = await measureImages(images, { deps });
  assert.equal(result.found, 5);
  assert.equal(result.measured, 3);
  assert.equal(result.totalBytes, 1000 + 250000 + 3000000);
  assert.equal(result.broken, 1);
  assert.deepEqual(result.heaviest.map((h) => h.name), ['c.jpg', 'b.jpg', 'a.jpg']);
  assert.ok(calls.includes('GET /b.jpg') && !calls.includes('GET /a.jpg'));

  const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://img.example/p${i}.jpg` }));
  calls.length = 0;
  const capped = await measureImages(many, { deps });
  assert.equal(capped.found, 40);
  assert.equal(capped.checked, 25);
  assert.equal(new Set(calls.map((c) => c.split(' ')[1])).size, 25);
});

test('PageSpeed: parsed when it works, skipped quietly on no key, quota, errors and timeouts', async () => {
  const sample = JSON.parse(fixture('pagespeed-sample.json'));
  assert.deepEqual(parsePageSpeed(sample), { available: true, performance: 54, lcpMs: 4123.4, cls: 0.123, totalBytes: 3456789 });
  assert.equal(parsePageSpeed({ lighthouseResult: { runtimeError: { code: 'NO_FCP' }, categories: {} } }).available, false);

  assert.deepEqual(await runPageSpeed('https://a.example/', ''), { available: false, reason: 'no_key' });
  let asked = null;
  const ok = await runPageSpeed('https://a.example/', 'KEY123', {
    fetchImpl: async (url) => {
      asked = url;
      return { ok: true, status: 200, json: async () => sample };
    },
  });
  assert.equal(ok.performance, 54);
  assert.equal(asked.searchParams.get('strategy'), 'mobile');
  assert.equal(asked.searchParams.get('category'), 'performance');
  assert.equal(asked.searchParams.get('url'), 'https://a.example/');
  const quota = await runPageSpeed('https://a.example/', 'KEY123', { fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.deepEqual(quota, { available: false, reason: 'quota' });
  const broken = await runPageSpeed('https://a.example/', 'KEY123', { fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(broken.available, false);
  const thrown = await runPageSpeed('https://a.example/', 'KEY123', {
    fetchImpl: async () => {
      throw new Error('failed https://www.googleapis.com/...&key=KEY123');
    },
  });
  assert.deepEqual(thrown, { available: false, reason: 'error' }, 'the error (which could carry the key) is not passed on');
  const slow = await runPageSpeed('https://a.example/', 'KEY123', {
    timeoutMs: 1000,
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  });
  assert.deepEqual(slow, { available: false, reason: 'timeout' });
});

test('srcset parsing keeps commas inside URLs', () => {
  assert.deepEqual(parseSrcset('a.jpg 1x, b.jpg 2x'), [
    { url: 'a.jpg', w: null, x: 1 },
    { url: 'b.jpg', w: null, x: 2 },
  ]);
  assert.deepEqual(
    parseSrcset('https://c.test/w_400,h_300/x.jpg 400w, https://c.test/w_800,h_600/x.jpg 800w').map((c) => c.url),
    ['https://c.test/w_400,h_300/x.jpg', 'https://c.test/w_800,h_600/x.jpg'],
  );
});

test('entities and text cleaning', () => {
  assert.equal(decodeEntities('Fish &amp; Chips &#8211; &#x2014; &rsquo;s &bogus;'), 'Fish & Chips – — ’s &bogus;');
  assert.equal(cleanText('  a\n\tb\u0000c​  '), 'a b c');
  assert.equal(cleanText('x'.repeat(300), 10), `${'x'.repeat(9)}…`);
});

test('the scanner stays fast on hostile HTML', () => {
  const nasty = [
    '<a "'.repeat(200000),
    '<'.repeat(1000000),
    `<div class="${'x'.repeat(1000000)}`,
    '<!--'.repeat(200000),
    `<a ${'b='.repeat(300000)}>`,
    `<script>${'</scrip'.repeat(150000)}`,
    `${'<h1>'.repeat(100000)}${'</h1>'.repeat(100000)}`,
  ];
  for (const html of nasty) {
    const started = Date.now();
    analyzeHtml(html, SITE);
    const ms = Date.now() - started;
    assert.ok(ms < 3000, `took ${ms} ms on ${html.slice(0, 20)}...`);
  }
  let tags = 0;
  scanHtml('<p class=a>x</p><br/><img src="a.png" alt=\'b\'>', { tag: () => (tags += 1) });
  assert.equal(tags, 4);
});

test('a whole run on a fixture: JSON report only, no raw HTML, JavaScript-only page noted', async () => {
  const html = fixture('spa-shell.html');
  const transport = async (url, opts) => {
    if (opts.method === 'GET' && url.pathname === '/') {
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from(html),
        bytes: Buffer.byteLength(html),
        truncated: false,
      };
    }
    return { status: 404, headers: {}, body: Buffer.alloc(0), bytes: 0, truncated: false };
  };
  const report = await runGrowthCheck(
    { url: 'acme-dental.example', business: '  Acme <b>Dental</b>\n Studio ' },
    { deps: { resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport } },
  );
  assert.equal(report.ok, true, report.error);
  assert.equal(report.business, 'Acme <b>Dental</b> Studio', 'business name is cleaned to one plain line (shown as text, never HTML)');
  assert.equal(report.url, 'https://acme-dental.example/');
  assert.equal(report.finalUrl, 'https://acme-dental.example/');
  assert.ok(Number.isInteger(report.score) && report.score >= 0 && report.score <= 100);
  assert.match(report.grade, /^[ABCDF]$/);
  assert.equal(report.groups.length, 4);
  assert.equal(report.speed.available, false);
  assert.equal(report.speed.message, 'Speed test unavailable right now.');
  assert.ok(report.topFixes.length >= 1 && report.topFixes.length <= 3);
  assert.ok(report.notes.some((n) => /drawn by JavaScript/.test(n)));
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /<script|<div id="root"|__APP_STATE__/, 'the fetched HTML is never echoed');
  JSON.parse(json);
});

test('a whole run maps site problems to plain words', async () => {
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  const respond = (status, headers = {}, body = '') => async () => ({
    status,
    headers,
    body: Buffer.from(body),
    bytes: Buffer.byteLength(body),
    truncated: false,
  });
  const run = (transport, url = 'site.example') => runGrowthCheck({ url }, { deps: { resolve, transport } });
  let r = await run(respond(404));
  assert.deepEqual([r.ok, r.code], [false, 'not_found']);
  assert.match(r.error, /error 404/);
  r = await run(respond(403));
  assert.equal(r.code, 'blocked');
  r = await run(respond(503));
  assert.equal(r.code, 'server_error');
  r = await run(respond(200, { 'content-type': 'application/pdf' }, '%PDF-1.7'));
  assert.equal(r.code, 'not_html');
  assert.match(r.error, /application\/pdf/);
  r = await run(async () => {
    throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  }, 'http://site.example/');
  assert.equal(r.code, 'unreachable');
  r = await run(async () => {
    throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  });
  assert.equal(r.code, 'timeout');
  r = await runGrowthCheck({ url: 'site.example' }, { deps: { resolve: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); } } });
  assert.equal(r.code, 'dns');
  assert.match(r.error, /couldn’t find a website/);
});

test('a bare domain whose HTTPS is broken is checked over http:// and fails the HTTPS check', async () => {
  const html = fixture('good-site.html');
  const transport = async (url) => {
    if (url.protocol === 'https:') throw Object.assign(new Error('bad cert'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html), bytes: html.length, truncated: false };
  };
  const report = await runGrowthCheck(
    { url: 'oldsite.example' },
    { deps: { resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport } },
  );
  assert.equal(report.ok, true);
  assert.equal(report.finalUrl, 'http://oldsite.example/');
  const https = report.groups.flatMap((g) => g.checks).find((c) => c.id === 'https');
  assert.equal(https.status, 'fail');
  assert.ok(report.notes.some((n) => /checked the http:\/\/ version/.test(n)));
});
