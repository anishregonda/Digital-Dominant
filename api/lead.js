// POST /api/lead  (Vercel Serverless Function, Node runtime)
//
// The website's own way to deliver a lead when DD Hub can't take it (paused,
// slow or down). The page tries the Hub first; only if that fails does it post
// here, and only if this fails too does it offer WhatsApp and email buttons.
//
// Body: JSON, 8 KB max: { name, phone, email, message, page, website }
//   `website` is the honeypot: people never see it, so a filled one is a bot.
// Answer: JSON only.
//   200 { ok: true }                           emailed to the agency inbox
//   400 { ok: false, code, error }             no name, no way to reply, a bad email or phone
//   403 / 405 / 413 / 415                      not from our pages, not POST, too big, not JSON
//   429 { ok: false, code, error }             more than 5 leads an hour from one visitor
//   502 { ok: false, code: 'send_failed' }     Resend refused it or didn't answer in time
//   503 { ok: false, code: 'not_configured' }  RESEND_API_KEY isn't set
// `error` is always plain words; the page falls back to WhatsApp and email on any failure.
//
// Env (Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY  required; the same Resend account DD Hub uses (digitaldominant.co.uk is verified there)
//   LEAD_TO         where leads go (default anish.digitaldominant@gmail.com)
//   LEAD_FROM       the sender, on the verified domain (default below)
//   RESEND_API_URL  tests only: another endpoint (https, or http on localhost)
// Nothing is stored and nothing about the visitor is logged: the lead exists only in the email.

import crypto from 'node:crypto';
import { clientIp, createRateLimiter, isAllowedOrigin, rateKey, readJsonBody } from './_lib/request-guards.js';

const MAX_BODY_BYTES = 8192;
const SEND_TIMEOUT_MS = 10000;
const DEFAULT_TO = 'anish.digitaldominant@gmail.com';
const DEFAULT_FROM = 'Digital Dominant website <website@digitaldominant.co.uk>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_RE = /^[a-z0-9._+'-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,22}[a-z0-9]$/i;
const PHONE_RE = /^\(?\+?[\d\s().-]+$/;
const LIMITS = { name: 80, phone: 40, email: 120, message: 5000, page: 300 };

const limiter = createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });

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

// Text from the form: control characters out (line breaks kept in the message only).
function clean(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  const text = multiline
    ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    : value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return text.replace(multiline ? /[ \t]+\n/g : /\s+/g, multiline ? '\n' : ' ').trim();
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Checks the fields; returns { lead } or { code, error } in plain words.
export function readLead(value) {
  for (const key of Object.keys(LIMITS)) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') {
      return { code: 'bad_request', error: 'Please use the form on the page.' };
    }
  }
  const lead = {
    name: clean(value.name),
    phone: clean(value.phone),
    email: clean(value.email),
    message: clean(value.message, { multiline: true }),
    page: clean(value.page),
  };
  for (const [key, max] of Object.entries(LIMITS)) {
    if (lead[key].length > max) return { code: 'too_long', error: 'That message is too long. Please shorten it a little.' };
  }
  if (!lead.name) return { code: 'missing_name', error: 'Please add your name.' };
  if (!lead.phone && !lead.email) return { code: 'missing_contact', error: 'Please add a phone number or an email address so we can reply.' };
  const digits = lead.phone.replace(/\D/g, '').length;
  if (lead.phone && (!PHONE_RE.test(lead.phone) || digits < 7 || digits > 15)) {
    return { code: 'bad_phone', error: 'Please check your phone number.' };
  }
  if (lead.email && !EMAIL_RE.test(lead.email)) return { code: 'bad_email', error: 'Please check your email address.' };
  if (lead.page && !lead.page.startsWith('/')) lead.page = '';
  return { lead };
}

export function composeEmail(lead) {
  const rows = [
    ['Name', lead.name],
    ['Phone', lead.phone],
    ['Email', lead.email],
    ['Page', lead.page ? `www.digitaldominant.co.uk${lead.page}` : ''],
  ].filter(([, v]) => v);
  const text = [
    'New lead from the Digital Dominant website (sent by the website because DD Hub could not take it).',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    lead.message || '(no message)',
  ].join('\n');
  const cell = (k, v) => {
    const safe = escapeHtml(v);
    if (k === 'Phone') return `<a href="tel:${escapeHtml(v.replace(/[^\d+]/g, ''))}">${safe}</a>`;
    if (k === 'Email') return `<a href="mailto:${safe}">${safe}</a>`;
    return safe;
  };
  const html = [
    '<p style="margin:0 0 12px;color:#555">New lead from the Digital Dominant website (sent by the website because DD Hub could not take it).</p>',
    '<table cellpadding="4" style="border-collapse:collapse">',
    ...rows.map(([k, v]) => `<tr><td style="color:#555;padding-right:12px">${k}</td><td><b>${cell(k, v)}</b></td></tr>`),
    '</table>',
    `<p style="white-space:pre-wrap;margin:16px 0 0">${escapeHtml(lead.message || '(no message)')}</p>`,
  ].join('\n');
  return { subject: `New website lead: ${lead.name}`, text, html };
}

function endpoint() {
  const raw = (process.env.RESEND_API_URL || '').trim();
  if (!raw) return RESEND_ENDPOINT;
  try {
    const u = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.href;
  } catch {
    // fall through
  }
  return RESEND_ENDPOINT;
}

async function deliver(lead, apiKey) {
  const { subject, text, html } = composeEmail(lead);
  const payload = {
    from: (process.env.LEAD_FROM || '').trim() || DEFAULT_FROM,
    to: [(process.env.LEAD_TO || '').trim() || DEFAULT_TO],
    subject,
    text,
    html,
    tags: [{ name: 'source', value: 'website-lead' }],
  };
  if (lead.email) payload.reply_to = lead.email;
  // The same lead sent twice (a double tap, a retry) within 24 hours is one email.
  const key = crypto.createHash('sha256').update(JSON.stringify([lead.name, lead.phone, lead.email, lead.message, lead.page])).digest('base64url').slice(0, 40);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `lead-${key}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      fail(res, 405, 'method', 'Please use the form on the page.', { Allow: 'POST' });
      return;
    }
    if (!isAllowedOrigin(req)) {
      fail(res, 403, 'origin', 'Please use the form on the Digital Dominant website.');
      return;
    }
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json') && !type.startsWith('text/plain')) {
      fail(res, 415, 'bad_request', 'Please use the form on the page.');
      return;
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      fail(res, body.status, body.code, body.error, body.status === 413 ? { Connection: 'close' } : undefined);
      return;
    }
    // A filled honeypot is a bot: answer as if it worked, send nothing.
    if (typeof body.value.website === 'string' && body.value.website.trim()) {
      send(res, 200, { ok: true });
      return;
    }
    const checked = readLead(body.value);
    if (!checked.lead) {
      fail(res, 400, checked.code, checked.error);
      return;
    }
    const apiKey = (process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) {
      fail(res, 503, 'not_configured', 'Our form is having a moment. Please send it on WhatsApp or by email instead.');
      return;
    }
    const limit = limiter.hit(rateKey(clientIp(req)));
    if (!limit.ok) {
      fail(res, 429, 'rate_limited', 'You have sent a few messages already. Please call or WhatsApp us instead.', { 'Retry-After': String(limit.retryAfterSec) });
      return;
    }
    if (!(await deliver(checked.lead, apiKey))) {
      fail(res, 502, 'send_failed', 'We couldn’t send that just now. Please send it on WhatsApp or by email instead.');
      return;
    }
    send(res, 200, { ok: true });
  } catch {
    if (!res.headersSent) fail(res, 500, 'error', 'Something went wrong. Please send it on WhatsApp or by email instead.');
    else res.end();
  }
}
