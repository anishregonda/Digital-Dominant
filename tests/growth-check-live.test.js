// Live runs of the Growth Check core against real websites, with NO PageSpeed
// key (the speed test is skipped and the image-weight check stands in). Each
// site must give a sensible report, or a clear plain-words error, in under 45 s.
// Needs internet access.
//   node tests/growth-check-live.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGrowthCheck } from '../api/_lib/growth-check-core.js';

const LIMIT_MS = 45000;
const STATUSES = new Set(['pass', 'warn', 'fail', 'skipped']);

function summary(report) {
  if (!report.ok) return `  error (${report.code}): ${report.error}`;
  const lines = [`  ${report.finalUrl}  score ${report.score} (${report.grade}, ${report.gradeLabel})  ${report.durationMs} ms`];
  for (const group of report.groups) {
    for (const c of group.checks) lines.push(`    ${c.status.padEnd(7)} ${c.name}: ${c.detail}`);
  }
  report.topFixes.forEach((f, i) => lines.push(`  fix ${i + 1}: ${f.text}`));
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

function assertSensible(report, started) {
  const elapsed = Date.now() - started;
  assert.ok(elapsed < LIMIT_MS, `took ${elapsed} ms`);
  assert.equal(report.ok, true, `expected a report, got: ${report.error}`);
  assert.ok(Number.isInteger(report.score) && report.score >= 0 && report.score <= 100);
  assert.match(report.grade, /^[ABCDF]$/);
  assert.ok(report.gradeLabel);
  assert.deepEqual(report.groups.map((g) => g.id), ['speed', 'basics', 'leads', 'tracking']);
  const checks = report.groups.flatMap((g) => g.checks);
  assert.equal(checks.length, 16);
  for (const c of checks) {
    assert.ok(STATUSES.has(c.status), `${c.id}: ${c.status}`);
    assert.ok(typeof c.detail === 'string' && c.detail.length > 0, `${c.id} has plain words`);
  }
  const speed = checks.find((c) => c.id === 'speed_score');
  assert.equal(speed.status, 'skipped', 'no PageSpeed key: speed is skipped');
  assert.equal(report.speed.available, false);
  assert.ok(Array.isArray(report.topFixes) && report.topFixes.length <= 3);
  for (const fix of report.topFixes) assert.ok(fix.text && !/[<>]/.test(fix.text));
  assert.doesNotMatch(JSON.stringify(report), /<(?:html|head|body|script|div)\b/i, 'no raw HTML in the report');
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

async function check(url, business) {
  const started = Date.now();
  const report = await runGrowthCheck({ url, business }, { pagespeedKey: '' });
  console.log(`\n${url}\n${summary(report)}`);
  return { report, started };
}

test('tuskertees.com', { timeout: 60000 }, async () => {
  const { report, started } = await check('https://tuskertees.com', 'Tusker Tees');
  const c = assertSensible(report, started);
  assert.equal(c.https.status, 'pass');
  assert.ok(report.images.found > 0, 'the homepage has images to weigh');
  assert.equal(report.business, 'Tusker Tees');
});

test('bhadrakaliclothstore.com', { timeout: 60000 }, async () => {
  const { report, started } = await check('https://bhadrakaliclothstore.com', 'Bhadrakali Cloth Store');
  const c = assertSensible(report, started);
  assert.equal(c.https.status, 'pass');
  assert.equal(c.click_to_call.status, 'pass');
  assert.equal(c.google_ads_tag.status, 'pass');
});

test('digitaldominant.co.uk (redirects to www)', { timeout: 60000 }, async () => {
  const { report, started } = await check('https://digitaldominant.co.uk', 'Digital Dominant');
  const c = assertSensible(report, started);
  assert.equal(report.finalUrl, 'https://www.digitaldominant.co.uk/');
  assert.equal(report.redirected, true);
  assert.equal(c.click_to_call.status, 'pass');
  assert.equal(c.whatsapp.status, 'pass');
});

test('example.com', { timeout: 60000 }, async () => {
  const { report, started } = await check('https://example.com', 'Example');
  const c = assertSensible(report, started);
  assert.equal(c.viewport.status, 'pass');
  assert.equal(c.click_to_call.status, 'fail');
  assert.ok(report.score < 60, 'a placeholder page scores low');
});

test('a domain that does not exist gives a clear error', { timeout: 60000 }, async () => {
  const { report, started } = await check('https://this-domain-does-not-exist-dd-growth-check.com', 'Nobody');
  assert.ok(Date.now() - started < LIMIT_MS);
  assert.equal(report.ok, false);
  assert.equal(report.code, 'dns');
  assert.equal(report.error, 'We couldn’t find a website at that address. Please check the spelling and try again.');
});
