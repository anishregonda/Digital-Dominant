// Contract tests for api/growth-check.js: POST only, same-origin only, 4 KB
// body, JSON only, 10 checks an hour per visitor, plain-words errors. Runs the
// handler both as plain Node (it reads the body stream) and the way Vercel's
// Node helpers call it (body already read into req.body). No outside network:
// every URL used here is refused or fails before any page is fetched, except
// the rate-limit test, which uses a reserved .invalid domain (NXDOMAIN).
//   node tests/growth-check-handler.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import handler from '../api/growth-check.js';
import { createRateLimiter, isAllowedOrigin, readJsonBody } from '../api/_lib/request-guards.js';

const PORT = 4318; // ports 4301-4320 only
const ORIGIN = `http://127.0.0.1:${PORT}`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function post(body, headers = {}) {
  const res = await fetch(`${ORIGIN}/api/growth-check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

test('handler over real HTTP (plain Node req/res)', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test('GET is refused with 405 and Allow: POST', async () => {
    const res = await fetch(`${ORIGIN}/api/growth-check`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /form/);
  });

  await t.test('other origins are refused (403), ours and the same host are fine', async () => {
    assert.equal((await post({ url: 'http://127.0.0.1/' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ url: 'http://127.0.0.1/' }, { origin: 'null' })).status, 403);
    // No Origin, no Referer: refused. Node's fetch always sends one, so use http directly.
    const status = await new Promise((resolve) => {
      const req = http.request(`${ORIGIN}/api/growth-check`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end('{"url":"example.com"}');
    });
    assert.equal(status, 403);
    // Referer from our page works when Origin is missing/null.
    const viaReferer = await post({ url: 'http://127.0.0.1/' }, { origin: 'null', referer: `${ORIGIN}/growth-check` });
    assert.equal(viaReferer.status, 400, 'got past the origin check (then refused the private address)');
  });

  await t.test('responses are JSON, never cached', async () => {
    const res = await post({ url: 'http://127.0.0.1/' });
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('bodies over 4 KB are refused (413)', async () => {
    const res = await post({ url: 'example.com', business: 'x'.repeat(5000) });
    assert.equal(res.status, 413);
    assert.equal(res.json.ok, false);
  });

  await t.test('bad JSON, wrong content type and wrong field types are refused', async () => {
    assert.equal((await post('{"url": ')).status, 400);
    assert.equal((await post('[1,2]')).status, 400);
    assert.equal((await post('')).status, 400);
    assert.equal((await post({ url: 'example.com' }, { 'content-type': 'text/html' })).status, 415);
    assert.equal((await post({ url: 'example.com', business: { evil: true } })).status, 400);
  });

  await t.test('private and malformed addresses get 400 with plain words', async () => {
    for (const [url, code] of [
      ['http://127.0.0.1/', 'private'],
      ['http://169.254.169.254/latest/meta-data/', 'private'],
      ['http://[::1]/', 'private'],
      ['file:///etc/passwd', 'bad_scheme'],
      ['ftp://example.com/', 'bad_scheme'],
      ['http://example.com:8080/', 'bad_port'],
      ['', 'missing_url'],
      [42, 'missing_url'],
    ]) {
      const res = await post({ url, business: 'Test' });
      assert.equal(res.status, 400, String(url));
      assert.deepEqual([res.json.ok, res.json.code], [false, code], String(url));
      assert.ok(res.json.error.length > 10);
    }
  });

  await t.test('10 checks an hour per visitor, then 429 with Retry-After', async () => {
    const visitor = { 'x-real-ip': '203.0.113.77' };
    // Typos don't count against the limit.
    for (let i = 0; i < 3; i++) assert.equal((await post({ url: 'ftp://typo' }, visitor)).status, 400);
    for (let i = 0; i < 10; i++) {
      const res = await post({ url: `https://no-such-site-${i}.invalid/`, business: 'Test' }, visitor);
      assert.equal(res.status, 422, `check ${i + 1} runs (and fails: no such site)`);
      assert.equal(res.json.code, 'dns');
    }
    const limited = await post({ url: 'https://no-such-site.invalid/' }, visitor);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, 'rate_limited');
    assert.match(limited.json.error, /try again in about \d+ minutes?/);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    // Someone else is not affected.
    const other = await post({ url: 'https://no-such-site.invalid/' }, { 'x-real-ip': '203.0.113.78' });
    assert.equal(other.status, 422);
  });
});

// ---- The way Vercel calls it: Node helpers have already read the body ----
function fakeReq({ method = 'POST', headers = {}, body, bodyThrows = false }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/api/growth-check';
  req.headers = { host: 'www.digitaldominant.co.uk', origin: 'https://www.digitaldominant.co.uk', 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress: '198.51.100.20' };
  Object.defineProperty(req, 'body', {
    get() {
      if (bodyThrows) throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
      return body;
    },
  });
  return req;
}

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200,
    headersSent: false,
    headers,
    body: '',
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body += chunk;
      this.headersSent = true;
    },
  };
}

async function callVercelStyle(options) {
  const req = fakeReq(options);
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body) };
}

test('handler the way Vercel calls it (req.body already parsed)', async () => {
  // Parsed JSON object
  let r = await callVercelStyle({ body: { url: 'http://10.0.0.1/', business: 'Test' } });
  assert.deepEqual([r.status, r.json.code], [400, 'private']);
  // text/plain gives a string
  r = await callVercelStyle({ headers: { 'content-type': 'text/plain' }, body: '{"url":"ftp://x.example"}' });
  assert.deepEqual([r.status, r.json.code], [400, 'bad_scheme']);
  // Vercel's parser throws on invalid JSON
  r = await callVercelStyle({ bodyThrows: true });
  assert.equal(r.status, 400);
  // A big pre-parsed body is still refused
  r = await callVercelStyle({ body: { url: 'example.com', business: 'x'.repeat(5000) } });
  assert.equal(r.status, 413);
  // Same-host origin on a preview deployment is allowed; another origin is not
  r = await callVercelStyle({
    headers: { host: 'dd-site-git-x-team.vercel.app', origin: 'https://dd-site-git-x-team.vercel.app' },
    body: { url: 'http://192.168.0.1/' },
  });
  assert.equal(r.status, 400);
  r = await callVercelStyle({ headers: { origin: 'https://dd-site-git-x-team.vercel.app' }, body: { url: 'example.com' } });
  assert.equal(r.status, 403);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
});

test('request guards on their own', async () => {
  const req = (headers) => ({ headers });
  assert.equal(isAllowedOrigin(req({ origin: 'https://www.digitaldominant.co.uk', host: 'x.vercel.app' })), true);
  assert.equal(isAllowedOrigin(req({ origin: 'https://digitaldominant.co.uk' })), true);
  assert.equal(isAllowedOrigin(req({ origin: 'http://localhost:5173' })), true);
  assert.equal(isAllowedOrigin(req({ origin: 'http://www.digitaldominant.co.uk' })), false, 'http version of the site is not the site');
  assert.equal(isAllowedOrigin(req({ origin: 'https://digitaldominant.co.uk.evil.example' })), false);
  assert.equal(isAllowedOrigin(req({ origin: 'https://evil.example', host: 'www.digitaldominant.co.uk' })), false);
  assert.equal(isAllowedOrigin(req({ referer: 'https://www.digitaldominant.co.uk/growth-check' })), true);
  assert.equal(isAllowedOrigin(req({})), false);

  const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.hit('a', 0).ok, true);
  assert.equal(limiter.hit('a', 10).ok, true);
  const third = limiter.hit('a', 20);
  assert.equal(third.ok, false);
  assert.equal(third.retryAfterSec, 1);
  assert.equal(limiter.hit('a', 1001).ok, true, 'the window slides');
  const small = createRateLimiter({ limit: 1, windowMs: 60000, maxKeys: 3 });
  for (let i = 0; i < 10; i++) small.hit(`k${i}`, i);
  assert.ok(small.size() <= 4, 'memory stays bounded');

  const stream = new EventEmitter();
  stream.headers = { 'content-length': '99999' };
  assert.equal((await readJsonBody(stream)).status, 413, 'a declared big body is refused before reading');
});
