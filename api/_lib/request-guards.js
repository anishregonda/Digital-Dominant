// Request rules for POST /api/growth-check: POST only, from our own pages,
// a small JSON body, and a per-visitor rate limit. Kept apart from the handler
// so the tests can exercise them directly.

import crypto from 'node:crypto';

export const MAX_BODY_BYTES = 4096;
export const RATE_LIMIT = 10; // checks per visitor...
export const RATE_WINDOW_MS = 60 * 60 * 1000; // ...per hour
export const SITE_ORIGINS = ['https://www.digitaldominant.co.uk', 'https://digitaldominant.co.uk'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function header(req, name) {
  const value = req.headers ? req.headers[name] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

// The host the browser asked for (on Vercel: the deployment's own domain).
export function requestHost(req) {
  const forwarded = header(req, 'x-forwarded-host');
  const host = (forwarded ? String(forwarded).split(',')[0] : header(req, 'host')) || '';
  return host.trim().toLowerCase();
}

// Same-origin only: the Origin header (or, failing that, the Referer) must be
// our site, the deployment's own host (so Vercel preview links work), or a
// localhost address while developing. Browsers always send Origin on a POST.
export function isAllowedOrigin(req, siteOrigins = SITE_ORIGINS) {
  let origin = header(req, 'origin');
  if (!origin || origin === 'null') {
    const referer = header(req, 'referer');
    if (!referer) return false;
    try {
      origin = new URL(referer).origin;
    } catch {
      return false;
    }
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (siteOrigins.includes(parsed.origin)) return true;
  if (LOCAL_HOSTS.has(parsed.hostname)) return true;
  const host = requestHost(req);
  return parsed.protocol === 'https:' && host !== '' && parsed.host.toLowerCase() === host;
}

// Vercel puts the visitor's address in x-real-ip / x-forwarded-for.
export function clientIp(req) {
  const real = header(req, 'x-real-ip');
  if (real) return String(real).trim();
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// The limiter only ever sees a salted hash, never the address itself.
const SALT = crypto.randomBytes(16);
export function rateKey(ip) {
  return crypto.createHash('sha256').update(SALT).update(String(ip)).digest('base64url').slice(0, 22);
}

// In-memory and per server instance: best effort, which is all we need to stop
// casual abuse. Keeps at most `maxKeys` visitors, oldest dropped first.
export function createRateLimiter({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, maxKeys = 5000 } = {}) {
  const hits = new Map();
  const prune = (now) => {
    for (const [key, times] of hits) {
      while (times.length && times[0] <= now - windowMs) times.shift();
      if (!times.length) hits.delete(key);
    }
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
  };
  return {
    hit(key, now = Date.now()) {
      if (hits.size > maxKeys) prune(now);
      const times = (hits.get(key) || []).filter((t) => t > now - windowMs);
      if (times.length >= limit) {
        hits.set(key, times);
        return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000)) };
      }
      times.push(now);
      hits.delete(key); // re-insert so the Map stays oldest-first
      hits.set(key, times);
      return { ok: true, remaining: limit - times.length, retryAfterSec: 0 };
    },
    size() {
      return hits.size;
    },
  };
}

function tooLarge() {
  return { ok: false, status: 413, code: 'too_large', error: 'That request is too large.' };
}

function badJson() {
  return { ok: false, status: 400, code: 'bad_request', error: 'We couldn’t read that request. Please use the form on the page.' };
}

function readStream(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

// Resolves { ok: true, value } with the parsed JSON object, or
// { ok: false, status, code, error }.
//
// On Vercel the Node helpers (on by default) read the body before the handler
// runs and expose it as req.body, parsed by content type; reading the stream
// again would find it empty. Plain Node (tests, local server) has no req.body,
// so the stream is read here, stopping as soon as it passes the limit.
export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(header(req, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  let preread;
  try {
    preread = req.body;
  } catch {
    return badJson(); // Vercel's parser throws on invalid JSON
  }
  let text;
  if (preread !== undefined && preread !== null) {
    if (typeof preread === 'string') text = preread;
    else if (Buffer.isBuffer(preread)) text = preread.toString('utf8');
    else if (typeof preread === 'object') {
      if (Buffer.byteLength(JSON.stringify(preread)) > maxBytes) return tooLarge();
      return Array.isArray(preread) ? badJson() : { ok: true, value: preread };
    } else return badJson();
  } else {
    try {
      text = await readStream(req, maxBytes);
    } catch {
      return badJson();
    }
    if (text === null) return tooLarge();
  }
  if (Buffer.byteLength(text) > maxBytes) return tooLarge();
  if (!text.trim()) return badJson();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return badJson();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return badJson();
  return { ok: true, value };
}
