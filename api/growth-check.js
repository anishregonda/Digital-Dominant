// POST /api/growth-check  (Vercel Serverless Function, Node runtime)
//
// Body: {"business": "Joe's Plumbing", "url": "joesplumbing.com"}  (4 KB max)
// Answer: JSON only.
//   200 { ok: true, score, grade, topFixes, groups, ... }   the report
//   400 { ok: false, code, error }   the address can't be checked (typo, private network...)
//   403 / 405 / 413 / 415            not from our pages, not POST, too big, not JSON
//   422 { ok: false, code, error }   the site couldn't be reached or read
//   429 { ok: false, code, error }   too many checks from this visitor (10 an hour)
// `error` is always plain words that can be shown as they are.
//
// The work happens in _lib/growth-check-core.js. Set PAGESPEED_API_KEY in the
// Vercel project to add Google's speed test; without it the check still runs.
// vercel.json gives this function maxDuration 60 s; a run stays under ~45 s.
// Nothing is stored and nothing about the visitor or the site is logged.

import { normalizeUrl, runGrowthCheck } from './_lib/growth-check-core.js';
import {
  MAX_BODY_BYTES,
  clientIp,
  createRateLimiter,
  isAllowedOrigin,
  rateKey,
  readJsonBody,
} from './_lib/request-guards.js';

const limiter = createRateLimiter();
const INPUT_CODES = new Set(['missing_url', 'invalid_url', 'too_long', 'bad_scheme', 'bad_port', 'credentials', 'private']);

function send(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

function fail(res, status, code, error, headers) {
  send(res, status, { ok: false, code, error }, headers);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      fail(res, 405, 'method', 'Please use the form on the Growth Check page.', { Allow: 'POST' });
      return;
    }
    if (!isAllowedOrigin(req)) {
      fail(res, 403, 'origin', 'This check only runs from the Digital Dominant website.');
      return;
    }
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json') && !type.startsWith('text/plain')) {
      fail(res, 415, 'bad_request', 'Please use the form on the Growth Check page.');
      return;
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      fail(res, body.status, body.code, body.error, body.status === 413 ? { Connection: 'close' } : undefined);
      return;
    }
    const { url, business } = body.value;
    if (business !== undefined && business !== null && typeof business !== 'string') {
      fail(res, 400, 'bad_request', 'Please enter your business name as text.');
      return;
    }
    // A typo shouldn't use up one of the visitor's checks: validate first.
    const normal = normalizeUrl(url);
    if (!normal.ok) {
      fail(res, 400, normal.code, normal.message);
      return;
    }
    const limit = limiter.hit(rateKey(clientIp(req)));
    if (!limit.ok) {
      const minutes = Math.max(1, Math.ceil(limit.retryAfterSec / 60));
      fail(
        res,
        429,
        'rate_limited',
        `You’ve run a lot of checks in the last hour. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}, or book a call and we’ll go through your site with you.`,
        { 'Retry-After': String(limit.retryAfterSec) },
      );
      return;
    }
    const report = await runGrowthCheck(
      { url, business: typeof business === 'string' ? business : '' },
      { pagespeedKey: process.env.PAGESPEED_API_KEY || '' },
    );
    if (report.ok) {
      send(res, 200, report);
      return;
    }
    fail(res, INPUT_CODES.has(report.code) ? 400 : 422, report.code, report.error);
  } catch {
    if (!res.headersSent) fail(res, 500, 'server', 'Something went wrong on our side. Please try again in a minute.');
    else res.end();
  }
}
