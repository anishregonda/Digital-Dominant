// Safe outbound requests for the Free Growth Check.
//
// The Growth Check fetches a page that a website visitor names, so every request
// it makes (the homepage, every redirect, every image it weighs) goes through
// these rules first:
//
//   1. http:// or https:// only, at most 2048 characters, no "user:password@",
//      and only the normal web ports (80 and 443).
//   2. The host name must resolve, and EVERY address it resolves to must be a
//      public internet address: no loopback, private (10/8, 172.16/12,
//      192.168/16), link-local (169.254/16, where cloud metadata services
//      live), carrier-grade NAT (100.64/10), multicast, reserved or
//      documentation ranges, and no IPv6 loopback, unique-local (fc00::/7),
//      link-local (fe80::/10) or IPv4-mapped forms of any of the above.
//   3. The connection is pinned to the addresses that were checked (a custom
//      DNS lookup hands the socket only those), so a second DNS answer cannot
//      swap in a private address after the check (DNS rebinding).
//   4. Redirects are followed by hand, at most 4, and every hop goes through
//      rules 1-3 again before anything connects to it.
//
// No dependencies: Node's own dns, http, https, net and zlib.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

export const MAX_URL_LENGTH = 2048;
export const MAX_REDIRECTS = 4;
export const ALLOWED_PORTS = new Set(['', '80', '443']);
const DNS_TIMEOUT_MS = 5000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// A normal mobile Chrome. Some sites serve phones a different page; the Growth
// Check is about what phone visitors get.
export const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

// ---------------------------------------------------------------------------
// Errors with a code the caller can turn into plain words
// ---------------------------------------------------------------------------
export class GuardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GuardError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// IP address rules
// ---------------------------------------------------------------------------
const IPV4_BLOCKED = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (also Alibaba Cloud metadata, 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments (incl. Oracle Cloud metadata 192.0.0.192)
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast 255.255.255.255
].map(([base, bits]) => [ipv4ToInt(base), bits]);

export function stripBrackets(host) {
  const h = String(host || '');
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function ipv4ToInt(address) {
  if (net.isIPv4(address) !== true) return null;
  const parts = address.split('.').map(Number);
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function isPublicIPv4Int(value) {
  if (value === null || value === undefined) return false;
  for (const [base, bits] of IPV4_BLOCKED) {
    const shift = 32 - bits;
    if (Math.floor(value / 2 ** shift) === Math.floor(base / 2 ** shift)) return false;
  }
  return true;
}

// "2001:db8::1" -> [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]; null if not IPv6.
function ipv6ToGroups(address) {
  let s = stripBrackets(address);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  if (s.includes('.')) {
    // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1
    const cut = s.lastIndexOf(':');
    const v4 = ipv4ToInt(s.slice(cut + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, cut + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array(fill).fill('0'), ...tail].map((h) => Number.parseInt(h, 16));
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return null;
  return groups;
}

function isPublicIPv6Groups(g) {
  if (!g) return false;
  const firstFiveZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // IPv4-mapped (::ffff:a.b.c.d): the socket really talks IPv4, so judge the IPv4 inside.
  if (firstFiveZero && g[5] === 0xffff) return isPublicIPv4Int(g[6] * 65536 + g[7]);
  // NAT64 well-known prefix (64:ff9b::/96): judge the IPv4 inside.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPublicIPv4Int(g[6] * 65536 + g[7]);
  }
  // Everything else outside global unicast (2000::/3) is local or special:
  // ::, ::1, IPv4-compatible ::a.b.c.d, fc00::/7, fe80::/10, ff00::/8, 64:ff9b:1::/48...
  if ((g[0] & 0xe000) !== 0x2000) return false;
  // ...and inside it, the special-purpose blocks:
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 IETF assignments (Teredo, ORCHID, benchmarking)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return false; // 2002::/16 6to4 (can wrap any IPv4, private ones too)
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // 3fff::/20 documentation
  return true;
}

// True only for a public unicast IPv4 or IPv6 address. Anything else (including
// a string that isn't an IP address at all) is false.
export function isPublicAddress(address) {
  const ip = stripBrackets(address);
  const kind = net.isIP(ip.split('%')[0]);
  if (kind === 4) return isPublicIPv4Int(ipv4ToInt(ip));
  if (kind === 6) return isPublicIPv6Groups(ipv6ToGroups(ip));
  return false;
}

// Names that only ever mean "this machine" or "this network".
const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa|corp)$/i;

// ---------------------------------------------------------------------------
// URL rules
// ---------------------------------------------------------------------------
const PLAIN = {
  missing_url: 'Please enter your website address, like yourbusiness.com.',
  invalid_url: 'That doesn’t look like a website address. Please enter it like yourbusiness.com.',
  too_long: 'That address is too long. Please enter just your website, like yourbusiness.com.',
  bad_scheme: 'Please enter a normal web address that starts with http:// or https://.',
  bad_port: 'Please enter a normal website address, without a port number like :8080.',
  credentials: 'Please enter the website address without a username or password in it.',
  private: 'That address points to a private or internal network, so we can’t check it. Please enter your public website.',
  dns: 'We couldn’t find a website at that address. Please check the spelling and try again.',
  too_many_redirects: 'That website sends visitors through too many redirects, so we stopped.',
  bad_redirect: 'That website redirects to an address we can’t follow.',
};

export function plainMessage(code) {
  return PLAIN[code] || PLAIN.invalid_url;
}

function bad(code) {
  return { ok: false, code, message: plainMessage(code) };
}

// Checks a parsed URL against rule 1. Returns { ok: true } or { ok: false, code, message }.
export function checkUrlShape(url) {
  if (!(url instanceof URL)) return bad('invalid_url');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad('bad_scheme');
  if (url.username || url.password) return bad('credentials');
  if (!ALLOWED_PORTS.has(url.port)) return bad('bad_port');
  if (url.href.length > MAX_URL_LENGTH) return bad('too_long');
  const host = stripBrackets(url.hostname);
  if (!host || host.length > 253) return bad('invalid_url');
  if (net.isIP(host)) return isPublicAddress(host) ? { ok: true } : bad('private');
  if (LOCAL_NAME.test(host.replace(/\.$/, ''))) return bad('private');
  if (!host.includes('.') || host.endsWith('.')) return bad('invalid_url');
  return { ok: true };
}

// What a visitor types -> a URL we're willing to fetch, or a plain-words refusal.
// "joesplumbing.com" and "www.joes.com/about" become https:// addresses.
export function normalizeUrl(input) {
  if (typeof input !== 'string') return bad('missing_url');
  let s = input.trim();
  if (!s) return bad('missing_url');
  if (s.length > MAX_URL_LENGTH) return bad('too_long');
  let schemeAdded = false;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  const hostWithPort = /^[^/?#:@\s]+:\d+(?:[/?#]|$)/.test(s); // "example.com:8080/..." is a host, not a scheme
  if (s.startsWith('//')) {
    s = `https:${s}`;
    schemeAdded = true;
  } else if (!hasScheme || hostWithPort) {
    s = `https://${s}`;
    schemeAdded = true;
  }
  let url;
  try {
    url = new URL(s);
  } catch {
    return bad('invalid_url');
  }
  const shape = checkUrlShape(url);
  if (!shape.ok) return shape;
  url.hash = '';
  return { ok: true, url, schemeAdded };
}

// ---------------------------------------------------------------------------
// DNS + address check (rule 2)
// ---------------------------------------------------------------------------
async function systemResolve(hostname) {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
}

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new GuardError('dns', 'DNS lookup timed out')), ms);
    const onAbort = () => reject(abortError(signal));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError(signal));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

// Resolves the URL's host and checks every address. Returns the checked
// addresses ([{ address, family }]) to pin the connection to. Throws GuardError.
// options.resolve and options.isAllowed exist so tests can stand in for DNS.
export async function resolveSafeAddresses(url, options = {}) {
  const resolve = options.resolve || systemResolve;
  const isAllowed = options.isAllowed || isPublicAddress;
  const host = stripBrackets(url.hostname);
  const kind = net.isIP(host);
  if (kind) {
    if (!isAllowed(host)) throw new GuardError('private', plainMessage('private'));
    return [{ address: host, family: kind }];
  }
  if (LOCAL_NAME.test(host.replace(/\.$/, ''))) throw new GuardError('private', plainMessage('private'));
  const cache = options.cache;
  let addresses = cache ? cache.get(host) : undefined;
  if (!addresses) {
    try {
      addresses = await withTimeout(Promise.resolve(resolve(host)), DNS_TIMEOUT_MS, options.signal);
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
      throw new GuardError('dns', plainMessage('dns'));
    }
    if (cache) cache.set(host, addresses);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new GuardError('dns', plainMessage('dns'));
  for (const entry of addresses) {
    if (!entry || !isAllowed(entry.address)) throw new GuardError('private', plainMessage('private'));
  }
  return addresses.map((entry) => ({ address: entry.address, family: entry.family || net.isIP(entry.address) }));
}

// ---------------------------------------------------------------------------
// One HTTP request, connection pinned to checked addresses (rule 3)
// ---------------------------------------------------------------------------
// The socket asks this for the host's address; it only ever gets the addresses
// we already checked, and each one is checked again on the way out.
export function pinnedLookup(addresses, isAllowed = isPublicAddress) {
  return (hostname, options, callback) => {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    const raw = typeof opts === 'number' ? opts : opts && opts.family;
    const family = raw === 'IPv4' ? 4 : raw === 'IPv6' ? 6 : raw;
    let list = addresses.filter((a) => isAllowed(a.address));
    if (family === 4 || family === 6) list = list.filter((a) => a.family === family);
    if (list.length === 0) {
      const error = new Error(`No permitted address for ${hostname}`);
      error.code = 'ENOTFOUND';
      cb(error);
      return;
    }
    if (opts && opts.all) {
      cb(null, list.map((a) => ({ address: a.address, family: a.family })));
      return;
    }
    cb(null, list[0].address, list[0].family);
  };
}

// The default transport: node:http / node:https with the pinned lookup, no
// connection reuse, a body cap (counted after decompression, so a small
// compressed bomb can't blow up), and a timeout. Never follows redirects.
//   options: { addresses, method, headers, signal, timeoutMs, maxBytes, readBody, isAllowed }
// Resolves { status, headers, body: Buffer, bytes, truncated }.
export function nodeTransport(url, options) {
  const {
    addresses,
    method = 'GET',
    headers = {},
    signal,
    timeoutMs = 10000,
    maxBytes = 2 * 1024 * 1024,
    readBody = true,
    isAllowed = isPublicAddress,
  } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const lib = url.protocol === 'https:' ? https : http;
    const host = stripBrackets(url.hostname);
    const requestOptions = {
      method,
      headers,
      agent: false, // a fresh, pinned connection every time; nothing reused across hosts
      timeout: timeoutMs,
      lookup: pinnedLookup(addresses, isAllowed),
    };
    if (signal) requestOptions.signal = signal;
    if (!net.isIP(host)) requestOptions.servername = host;

    let req;
    try {
      req = lib.request(url, requestOptions, (res) => {
        const status = res.statusCode || 0;
        const result = { status, headers: res.headers, body: Buffer.alloc(0), bytes: 0, truncated: false };
        const wantBody = readBody && method !== 'HEAD' && !REDIRECT_STATUSES.has(status);
        if (!wantBody) {
          res.destroy();
          finish(resolve, result);
          return;
        }
        let stream = res;
        const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase();
        try {
          if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
          else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
          else if (encoding === 'deflate') stream = res.pipe(zlib.createUnzip());
        } catch {
          stream = res;
        }
        const chunks = [];
        let size = 0;
        const done = () => {
          result.body = Buffer.concat(chunks);
          result.bytes = result.body.length;
          finish(resolve, result);
        };
        stream.on('data', (chunk) => {
          if (settled) return;
          const room = maxBytes - size;
          if (chunk.length > room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            size = maxBytes;
            result.truncated = true;
            done();
            res.destroy();
            if (stream !== res) stream.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on('end', done);
        stream.on('error', (error) => {
          if (result.truncated) return;
          const e = new Error('The page could not be read');
          e.code = error && error.code === 'Z_DATA_ERROR' ? 'EBADBODY' : (error && error.code) || 'EBADBODY';
          finish(reject, e);
        });
        res.on('close', () => {
          if (!res.complete && !result.truncated) {
            finish(reject, Object.assign(new Error('Connection closed early'), { code: 'ECONNRESET' }));
          }
        });
      });
    } catch (error) {
      finish(reject, error);
      return;
    }
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', (error) => finish(reject, error));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fetch with redirects followed by hand (rule 4)
// ---------------------------------------------------------------------------
// options: { method, headers, signal, timeoutMs, maxBytes, readBody, maxRedirects,
//            resolve, isAllowed, transport, cache }
// Resolves { status, headers, body, bytes, truncated, url (final URL), redirects: [hrefs] }.
// Throws GuardError for anything the rules refuse, or the transport's error.
export async function safeFetch(startUrl, options = {}) {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const transport = options.transport || nodeTransport;
  const isAllowed = options.isAllowed || isPublicAddress;
  const headers = { 'user-agent': BROWSER_UA, ...(options.headers || {}) };
  let url = startUrl instanceof URL ? new URL(startUrl.href) : new URL(String(startUrl));
  const redirects = [];
  for (;;) {
    const shape = checkUrlShape(url);
    if (!shape.ok) throw new GuardError(shape.code, shape.message);
    if (options.signal && options.signal.aborted) throw abortError(options.signal);
    const addresses = await resolveSafeAddresses(url, {
      resolve: options.resolve,
      isAllowed,
      cache: options.cache,
      signal: options.signal,
    });
    const res = await transport(url, {
      addresses,
      method: options.method || 'GET',
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      readBody: options.readBody !== false,
      isAllowed,
    });
    const location = res.headers && res.headers.location;
    if (REDIRECT_STATUSES.has(res.status) && location) {
      if (redirects.length >= maxRedirects) throw new GuardError('too_many_redirects', plainMessage('too_many_redirects'));
      let next;
      try {
        next = new URL(Array.isArray(location) ? location[0] : location, url);
      } catch {
        throw new GuardError('bad_redirect', plainMessage('bad_redirect'));
      }
      next.hash = '';
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new GuardError('bad_redirect', plainMessage('bad_redirect'));
      }
      // A loop (A -> B -> A) simply runs into the redirect limit.
      redirects.push(url.href);
      url = next;
      continue;
    }
    return { ...res, url, redirects };
  }
}
