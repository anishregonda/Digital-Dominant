// Contract tests for api/lead.js, the website's own lead route for when DD Hub
// can't take a lead: POST only, same-origin only, JSON only, 8 KB, plain-words
// errors, a silent honeypot, 503 without a Resend key, and the email Resend gets.
// A fake Resend on localhost stands in for the real one; nothing leaves the machine.
//   node tests/lead-handler.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import handler, { composeEmail, readLead } from '../api/lead.js';

const PORT = 4319; // ports 4301-4320 only
const RESEND_PORT = 4320;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const GOOD = { name: 'Pat Smith', phone: '+1 402 555 0199', email: 'pat@example.com', message: 'Roof leak over the garage.\nCan you look this week?', page: '/book.html?utm_source=google', website: '' };

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// A stand-in for Resend: records what it was sent, answers with `status`.
async function fakeResend() {
  const calls = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(status < 300 ? '{"id":"test-email"}' : '{"message":"refused"}');
    });
  });
  await listen(server, RESEND_PORT);
  return { calls, server, setStatus: (s) => { status = s; } };
}

async function post(body, headers = {}) {
  const res = await fetch(`${ORIGIN}/api/lead`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-real-ip': headers['x-real-ip'] || '203.0.113.1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

test('readLead: plain-words checks, cleaned text', () => {
  assert.equal(readLead({ ...GOOD, name: '  ' }).code, 'missing_name');
  assert.equal(readLead({ ...GOOD, phone: '', email: '' }).code, 'missing_contact');
  assert.equal(readLead({ ...GOOD, phone: '12' }).code, 'bad_phone');
  assert.equal(readLead({ ...GOOD, email: 'pat@' }).code, 'bad_email');
  assert.equal(readLead({ ...GOOD, name: 'x'.repeat(81) }).code, 'too_long');
  assert.equal(readLead({ ...GOOD, name: 42 }).code, 'bad_request');
  assert.ok(readLead({ ...GOOD, email: '' }).lead, 'a phone alone is enough');
  assert.ok(readLead({ ...GOOD, phone: '' }).lead, 'an email alone is enough');
  const { lead } = readLead({ ...GOOD, name: 'Pat\u0000 \n Smith', page: 'https://evil.example/' });
  assert.equal(lead.name, 'Pat Smith');
  assert.equal(lead.page, '', 'only our own paths are kept');
  assert.equal(lead.message, 'Roof leak over the garage.\nCan you look this week?');
});

test('composeEmail: every field, escaped HTML, tap and mail links', () => {
  const { lead } = readLead({ ...GOOD, name: 'Pat <b>Smith</b>' });
  const mail = composeEmail(lead);
  assert.equal(mail.subject, 'New website lead: Pat <b>Smith</b>');
  assert.match(mail.text, /Name: Pat <b>Smith<\/b>/);
  assert.match(mail.text, /Phone: \+1 402 555 0199/);
  assert.match(mail.text, /Page: www\.digitaldominant\.co\.uk\/book\.html\?utm_source=google/);
  assert.match(mail.text, /Roof leak over the garage\.\nCan you look this week\?$/);
  assert.match(mail.html, /Pat &lt;b&gt;Smith&lt;\/b&gt;/);
  assert.doesNotMatch(mail.html, /<b>Smith<\/b>/);
  assert.match(mail.html, /href="tel:\+14025550199"/);
  assert.match(mail.html, /href="mailto:pat@example\.com"/);
});

test('handler over real HTTP', async (t) => {
  const server = await listen(http.createServer((req, res) => handler(req, res)), PORT);
  const resend = await fakeResend();
  const saved = { ...process.env };
  t.after(() => {
    server.close();
    resend.server.close();
    for (const k of ['RESEND_API_KEY', 'RESEND_API_URL', 'LEAD_TO', 'LEAD_FROM']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  delete process.env.RESEND_API_KEY;
  process.env.RESEND_API_URL = `http://127.0.0.1:${RESEND_PORT}/emails`;

  await t.test('GET is refused (405, Allow: POST)', async () => {
    const res = await fetch(`${ORIGIN}/api/lead`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });

  await t.test('other sites, other types and big bodies are refused', async () => {
    assert.equal((await post(GOOD, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(GOOD, { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await post({ ...GOOD, message: 'x'.repeat(9000) })).status, 413);
    assert.equal((await post('{nope')).status, 400);
  });

  await t.test('bad fields get plain words (400)', async () => {
    const res = await post({ ...GOOD, phone: '', email: '' });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'missing_contact');
    assert.match(res.json.error, /phone number or an email/);
  });

  await t.test('no Resend key: 503 and nothing sent', async () => {
    const res = await post(GOOD);
    assert.equal(res.status, 503);
    assert.equal(res.json.code, 'not_configured');
    assert.equal(resend.calls.length, 0);
  });

  process.env.RESEND_API_KEY = 're_test_key';

  await t.test('the honeypot answers ok and sends nothing', async () => {
    const res = await post({ ...GOOD, website: 'http://spam.example' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(resend.calls.length, 0);
  });

  await t.test('a good lead is emailed: to, from, reply-to, subject, idempotency key', async () => {
    const res = await post(GOOD, { 'x-real-ip': '203.0.113.7' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(resend.calls.length, 1);
    const { headers, body } = resend.calls[0];
    assert.equal(headers.authorization, 'Bearer re_test_key');
    assert.match(headers['idempotency-key'], /^lead-[A-Za-z0-9_-]{40}$/);
    assert.deepEqual(body.to, ['anish.digitaldominant@gmail.com']);
    assert.equal(body.from, 'Digital Dominant website <website@digitaldominant.co.uk>');
    assert.equal(body.reply_to, 'pat@example.com');
    assert.equal(body.subject, 'New website lead: Pat Smith');
    assert.match(body.text, /Phone: \+1 402 555 0199/);
    // The same lead again: same key, so Resend sends it once.
    await post(GOOD, { 'x-real-ip': '203.0.113.7' });
    assert.equal(resend.calls[1].headers['idempotency-key'], headers['idempotency-key']);
  });

  await t.test('LEAD_TO and LEAD_FROM override the defaults; no reply-to without an email', async () => {
    process.env.LEAD_TO = 'leads@example.com';
    process.env.LEAD_FROM = 'Site <site@digitaldominant.co.uk>';
    const before = resend.calls.length;
    const res = await post({ ...GOOD, email: '' }, { 'x-real-ip': '203.0.113.8' });
    assert.equal(res.status, 200);
    const { body } = resend.calls[before];
    assert.deepEqual(body.to, ['leads@example.com']);
    assert.equal(body.from, 'Site <site@digitaldominant.co.uk>');
    assert.equal(body.reply_to, undefined);
    delete process.env.LEAD_TO;
    delete process.env.LEAD_FROM;
  });

  await t.test('Resend refuses: 502 in plain words', async () => {
    resend.setStatus(422);
    const res = await post(GOOD, { 'x-real-ip': '203.0.113.9' });
    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'send_failed');
    assert.match(res.json.error, /WhatsApp or by email/);
    resend.setStatus(200);
  });

  await t.test('more than 5 an hour from one visitor: 429', async () => {
    const ip = '203.0.113.50';
    for (let i = 0; i < 5; i += 1) assert.equal((await post({ ...GOOD, message: `try ${i}` }, { 'x-real-ip': ip })).status, 200);
    const res = await post({ ...GOOD, message: 'try 6' }, { 'x-real-ip': ip });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  });
});
