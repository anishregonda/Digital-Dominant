// The Free Growth Check, minus the HTTP plumbing (that's api/growth-check.js).
//
//   runGrowthCheck({ url, business }, options) -> a JSON report (never raw HTML)
//
// What one run does, kept under ~45 seconds in total:
//   1. Normalise and check the address (net-guard.js): http/https only, public
//      addresses only, ports 80/443, every redirect re-checked.
//   2. If PAGESPEED_API_KEY is set, start Google PageSpeed Insights (mobile,
//      performance) in parallel, with a ~30 s timeout. No key, a quota error
//      (429) or any other failure just means "speed test unavailable"; the
//      image-weight check still runs.
//   3. Fetch the page: 10 s timeout, 2 MB cap, a normal browser user-agent. A
//      bare domain whose HTTPS doesn't work is tried again on http:// (10 s more).
//   4. Read the HTML once (analyzeHtml) and weigh up to 25 of its images with
//      HEAD / one-byte range requests in parallel (short timeouts). On Wix,
//      also read the site's tag list (Wix adds tracking codes after the page loads).
//   5. Turn the facts into plain-words checks, a 0-100 score, a grade and the
//      top 3 fixes. Where the page doesn't let us see something (a page drawn
//      by JavaScript, Wix tags we couldn't read), the check is "not checked"
//      and left out of the score, never reported as missing.
//
// SCORING. Every check has a weight (points). Pass earns all of its points,
// warn half, fail none. A check that couldn't run (no speed test, images that
// couldn't be weighed) is left out of both sides, so
//     score = round(points earned / points possible x 100).
// The Google speed score earns points in proportion (54/100 -> 54% of 14).
// Weights, summing to 100:
//
//   Speed (28)              Mobile & SEO basics (40)    Getting leads (20)    Tracking (12)
//   Google speed score 14   HTTPS                10     Tap-to-call     10    Analytics / GTM  6
//   Image weight       10   Fits phone screens   10     Contact form     8    Google Ads tag   3
//   Page code size      4   Page title            5     WhatsApp link    2    Meta Pixel       3
//                           Search description    4
//                           One clear H1          4
//                           Business schema       4
//                           Open Graph tags       3
//
// Grades: A 90+, B 80-89, C 70-79, D 60-69, F below 60.
// Top 3 fixes: the failed or half-passed checks that lose the most points
// (ties go to whatever costs leads soonest: calls and forms first).

import {
  GuardError,
  normalizeUrl,
  plainMessage,
  resolveSafeAddresses,
  safeFetch,
} from './net-guard.js';

export { normalizeUrl } from './net-guard.js';

export const BUDGET_MS = 44000; // whole run
export const PAGE_TIMEOUT_MS = 10000; // homepage fetch, redirects included
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGESPEED_TIMEOUT_MS = 30000;
export const MAX_IMAGES = 25;
export const IMAGE_TIMEOUT_MS = 5000; // per image request
export const IMAGE_PHASE_MS = 9000; // all images together
export const IMAGE_CONCURRENCY = 12;
export const HEAVY_IMAGES_BYTES = 3 * 1024 * 1024; // "heavy page" (fail)
export const OK_IMAGES_BYTES = 1.5 * 1024 * 1024; // under this passes
export const HEAVY_IMAGE_FILE_BYTES = 300 * 1024; // named as a heavy file

export const GROUPS = [
  { id: 'speed', title: 'Speed' },
  { id: 'basics', title: 'Mobile & SEO basics' },
  { id: 'leads', title: 'Getting leads' },
  { id: 'tracking', title: 'Tracking' },
];

export const CHECKS = [
  { id: 'speed_score', group: 'speed', weight: 14, name: 'Google mobile speed score' },
  { id: 'image_weight', group: 'speed', weight: 10, name: 'Image weight' },
  { id: 'html_size', group: 'speed', weight: 4, name: 'Page code size' },
  { id: 'https', group: 'basics', weight: 10, name: 'Secure (HTTPS)' },
  { id: 'viewport', group: 'basics', weight: 10, name: 'Fits phone screens' },
  { id: 'title', group: 'basics', weight: 5, name: 'Page title' },
  { id: 'meta_description', group: 'basics', weight: 4, name: 'Search description' },
  { id: 'h1', group: 'basics', weight: 4, name: 'One clear headline (H1)' },
  { id: 'structured_data', group: 'basics', weight: 4, name: 'Business details for Google' },
  { id: 'open_graph', group: 'basics', weight: 3, name: 'Link preview when shared' },
  { id: 'click_to_call', group: 'leads', weight: 10, name: 'Tap-to-call phone number' },
  { id: 'contact_form', group: 'leads', weight: 8, name: 'Contact or quote form' },
  { id: 'whatsapp', group: 'leads', weight: 2, name: 'WhatsApp chat link' },
  { id: 'analytics', group: 'tracking', weight: 6, name: 'Google Analytics or Tag Manager' },
  { id: 'google_ads_tag', group: 'tracking', weight: 3, name: 'Google Ads tag' },
  { id: 'meta_pixel', group: 'tracking', weight: 3, name: 'Meta (Facebook) Pixel' },
];

// When two fixes lose the same points, the one earlier here goes first.
const FIX_PRIORITY = [
  'click_to_call',
  'contact_form',
  'https',
  'viewport',
  'speed_score',
  'image_weight',
  'title',
  'h1',
  'meta_description',
  'analytics',
  'google_ads_tag',
  'structured_data',
  'meta_pixel',
  'open_graph',
  'html_size',
  'whatsapp',
];

const CREDIT = { pass: 1, warn: 0.5, fail: 0 };

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', times: '×', eacute: 'é',
  egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', deg: '°', pound: '£', euro: '€',
  rupee: '₹', zwj: '', zwnj: '', shy: '',
};

export function decodeEntities(text) {
  if (!text || text.indexOf('&') === -1) return text || '';
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// Plain, single-line, length-capped text we can safely show (rendered with
// textContent on the page, never as HTML).
export function cleanText(text, max = 120) {
  const chars = Array.from(
    String(text || '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

export function cleanBusinessName(name) {
  return cleanText(typeof name === 'string' ? name : '', 80);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function isAsciiLetter(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isTagNameCode(c) {
  return isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
}

// ---------------------------------------------------------------------------
// HTML scanner: one linear pass, like a browser's tokenizer (no regex over
// the whole document, so a hostile page can't make it crawl).
// ---------------------------------------------------------------------------
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);

function findRawTextEnd(html, name, from) {
  // The first "</name" followed by whitespace, "/" or ">".
  const lower = `</${name}`;
  let i = from;
  for (;;) {
    const at = indexOfCaseInsensitive(html, lower, i);
    if (at === -1) return { contentEnd: html.length, next: html.length };
    const after = html.charCodeAt(at + lower.length);
    if (Number.isNaN(after) || after === 62 || after === 47 || isSpaceCode(after)) {
      const close = html.indexOf('>', at + lower.length);
      return { contentEnd: at, next: close === -1 ? html.length : close + 1 };
    }
    i = at + lower.length;
  }
}

function indexOfCaseInsensitive(haystack, needle, from) {
  // needle is ASCII lower case. Look for its first character in either case.
  const first = needle.charCodeAt(0);
  const n = haystack.length;
  const m = needle.length;
  for (let i = from; i <= n - m; i++) {
    const c = haystack.charCodeAt(i);
    if (c !== first) continue;
    let ok = true;
    for (let j = 1; j < m; j++) {
      let h = haystack.charCodeAt(i + j);
      if (h >= 65 && h <= 90) h += 32;
      if (h !== needle.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

// Calls visit.tag({ name, closing, attrs, start, end }), visit.text(start, end)
// and visit.raw({ name, attrs, content }) for raw-text elements (script, style,
// title...). Attribute values come back with entities decoded.
export function scanHtml(html, visit) {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (visit.text) visit.text(i, n);
      return;
    }
    if (lt > i && visit.text) visit.text(i, lt);
    let p = lt + 1;
    if (html.startsWith('!--', p)) {
      const end = html.indexOf('-->', p + 3);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const c0 = html.charCodeAt(p);
    if (c0 === 33 || c0 === 63) {
      // <!doctype ...>, <![CDATA[ ...]]>, <?xml ...?>
      const end = html.indexOf('>', p);
      i = end === -1 ? n : end + 1;
      continue;
    }
    let closing = false;
    if (c0 === 47) {
      closing = true;
      p += 1;
    }
    if (!isAsciiLetter(html.charCodeAt(p))) {
      // A "<" that isn't a tag, e.g. "a < b".
      if (visit.text) visit.text(lt, lt + 1);
      i = lt + 1;
      continue;
    }
    const nameStart = p;
    while (p < n && isTagNameCode(html.charCodeAt(p))) p += 1;
    const name = html.slice(nameStart, p).toLowerCase();
    const attrs = {};
    let ended = false;
    while (p < n) {
      while (p < n && (isSpaceCode(html.charCodeAt(p)) || html.charCodeAt(p) === 47)) p += 1;
      if (p >= n) break;
      if (html.charCodeAt(p) === 62) {
        p += 1;
        ended = true;
        break;
      }
      const attrStart = p;
      while (p < n) {
        const c = html.charCodeAt(p);
        if (isSpaceCode(c) || c === 62 || c === 47 || (c === 61 && p > attrStart)) break;
        p += 1;
      }
      if (p === attrStart) {
        p += 1;
        continue;
      }
      const attrName = html.slice(attrStart, p).toLowerCase();
      while (p < n && isSpaceCode(html.charCodeAt(p))) p += 1;
      let value = '';
      if (html.charCodeAt(p) === 61) {
        p += 1;
        while (p < n && isSpaceCode(html.charCodeAt(p))) p += 1;
        const q = html.charCodeAt(p);
        if (q === 34 || q === 39) {
          const end = html.indexOf(q === 34 ? '"' : "'", p + 1);
          if (end === -1) {
            p = n;
            break;
          }
          value = html.slice(p + 1, end);
          p = end + 1;
        } else {
          const valueStart = p;
          while (p < n && !isSpaceCode(html.charCodeAt(p)) && html.charCodeAt(p) !== 62) p += 1;
          value = html.slice(valueStart, p);
        }
      }
      if (!Object.prototype.hasOwnProperty.call(attrs, attrName)) attrs[attrName] = decodeEntities(value);
    }
    if (!ended) return; // a tag cut off by the end of the document is dropped, as browsers do
    if (visit.tag) visit.tag({ name, closing, attrs, start: lt, end: p });
    i = p;
    if (!closing && RAW_TEXT.has(name)) {
      const { contentEnd, next } = findRawTextEnd(html, name, p);
      if (visit.raw) visit.raw({ name, attrs, content: html.slice(p, contentEnd) });
      if (visit.tag) visit.tag({ name, closing: true, attrs: {}, start: contentEnd, end: next });
      i = next;
    }
  }
}

function stripTags(fragment) {
  // Text of a small fragment (an H1): drop tags, keep img alt text.
  let out = '';
  scanHtml(fragment, {
    text(start, end) {
      out += fragment.slice(start, end);
    },
    tag(tag) {
      if (!tag.closing && tag.name === 'img' && tag.attrs.alt) out += ` ${tag.attrs.alt} `;
      else if (!tag.closing && (tag.name === 'br' || tag.name === 'p' || tag.name === 'div')) out += ' ';
    },
  });
  return cleanText(decodeEntities(out), 200);
}

// srcset -> [{ url, w, x }] following the spec's splitting rules (URLs may contain commas).
export function parseSrcset(value) {
  const out = [];
  const s = String(value || '');
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpaceCode(s.charCodeAt(i)) || s[i] === ',')) i += 1;
    if (i >= n) break;
    let j = i;
    while (j < n && !isSpaceCode(s.charCodeAt(j))) j += 1;
    let url = s.slice(i, j);
    let descriptor = '';
    if (url.endsWith(',')) {
      // Trim trailing commas by hand: a regex like /,+$/ backtracks on "x,,,,y," and
      // a hostile page could make it crawl.
      let end = url.length;
      while (end > 0 && url.charCodeAt(end - 1) === 44) end -= 1;
      url = url.slice(0, end);
      i = j;
    } else {
      let k = j;
      while (k < n && s[k] !== ',') k += 1;
      // Real descriptors are a few characters ("640w", "2x"); never run a regex over more.
      descriptor = s.slice(j, Math.min(k, j + 64)).trim();
      i = k + 1;
    }
    if (!url) continue;
    const w = /(?:^|\s)(\d{1,5})w(?=\s|$)/.exec(descriptor);
    const x = /(?:^|\s)(\d{1,2}(?:\.\d{1,3})?)x(?=\s|$)/.exec(descriptor);
    out.push({ url, w: w ? Number(w[1]) : null, x: x ? Number(x[1]) : null });
  }
  return out;
}

// The phone we weigh images for: 390 CSS pixels wide, 3 device pixels per CSS
// pixel (an iPhone; most Android phones are close).
export const PHONE_WIDTH = 390;
export const PHONE_DPR = 3;

// The candidate that phone would download, the way Chrome picks: work out how
// wide the image is on screen from `sizes`, then take the smallest candidate
// that is sharp enough, or the one below it if that's nearly as sharp.
export function pickSrcsetCandidate(list, sizes) {
  if (!list.length) return null;
  const withWidth = list.filter((c) => c.w);
  const slot = Math.max(1, slotWidth(sizes));
  const byDensity = (withWidth.length ? withWidth.map((c) => ({ url: c.url, d: c.w / slot })) : list.map((c) => ({ url: c.url, d: c.x || 1 })))
    .sort((a, b) => a.d - b.d);
  for (let k = 0; k < byDensity.length; k++) {
    if (byDensity[k].d >= PHONE_DPR) {
      if (k > 0 && PHONE_DPR < Math.sqrt(byDensity[k - 1].d * byDensity[k].d)) return byDensity[k - 1].url;
      return byDensity[k].url;
    }
  }
  return byDensity[byDensity.length - 1].url;
}

// How wide (CSS px) an image shows on the phone, from its `sizes` attribute:
// "(max-width: 767px) 100vw, 50vw", "(min-width: 769px) 160px, 110px",
// "auto, 400px", "calc((100vw - 35px) / 2)". The first entry whose condition
// fits the phone wins; anything we can't read means the full screen width.
export function slotWidth(sizes) {
  const text = String(sizes || '').slice(0, 1000);
  for (const raw of splitTopLevel(text)) {
    const entry = raw.trim();
    if (!entry || /^auto$/i.test(entry)) continue;
    const at = lengthStart(entry);
    const condition = entry.slice(0, at).trim();
    if (condition && !mediaFitsPhone(condition)) continue;
    const width = cssLengthPx(entry.slice(at).trim());
    return width === null ? PHONE_WIDTH : width;
  }
  return PHONE_WIDTH;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, k));
      from = k + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

// Where the length starts in "(media condition) length": the last word, or the
// whole calc(...) at the end.
function lengthStart(entry) {
  let k = entry.length - 1;
  if (entry[k] === ')') {
    let depth = 0;
    for (; k >= 0; k--) {
      if (entry[k] === ')') depth += 1;
      else if (entry[k] === '(') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    while (k > 0 && /[a-z-]/i.test(entry[k - 1])) k -= 1;
    return Math.max(0, k);
  }
  while (k >= 0 && !/\s/.test(entry[k])) k -= 1;
  return k + 1;
}

// "(min-width: 769px)", "(max-width: 47.9375em) and (min-width: 20em)".
function mediaFitsPhone(condition) {
  return condition.split(/\s+and\s+/i).every((part) => {
    const m = /^\(\s*(min|max)-width\s*:\s*(\d{1,5}(?:\.\d{1,4})?)(px|em|rem)\s*\)$/i.exec(part.trim());
    if (!m) return false; // a condition we don't read: assume it isn't the phone
    const px = Number(m[2]) * (m[3].toLowerCase() === 'px' ? 1 : 16);
    return m[1].toLowerCase() === 'min' ? PHONE_WIDTH >= px : PHONE_WIDTH <= px;
  });
}

// "100vw", "160px", "22rem", "calc((100vw - 35px) / 2)" -> CSS px, or null.
function cssLengthPx(text) {
  const calc = /^calc\((.*)\)$/i.exec(text);
  const src = calc ? calc[1] : text;
  let i = 0;
  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i += 1;
  };
  const factor = () => {
    skip();
    if (src[i] === '(') {
      i += 1;
      const v = sum();
      skip();
      if (src[i] !== ')') throw new Error('calc');
      i += 1;
      return v;
    }
    const m = /^(\d{1,5}(?:\.\d{1,4})?|\.\d{1,4})(vw|px|rem|em)?/i.exec(src.slice(i, i + 24));
    if (!m) throw new Error('calc');
    i += m[0].length;
    const n = Number(m[1]);
    const unit = (m[2] || '').toLowerCase();
    return unit === 'vw' ? (n * PHONE_WIDTH) / 100 : unit === 'rem' || unit === 'em' ? n * 16 : n;
  };
  const product = () => {
    let v = factor();
    for (;;) {
      skip();
      const op = src[i];
      if (op !== '*' && op !== '/') return v;
      i += 1;
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
  };
  const sum = () => {
    let v = product();
    for (;;) {
      skip();
      const op = src[i];
      if (op !== '+' && op !== '-') return v;
      i += 1;
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
  };
  try {
    const v = sum();
    skip();
    return i === src.length && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

const PLACEHOLDER_SRC = /^data:|(?:^|\/)(?:blank|spacer|pixel|placeholder|lazy[-_]?load(?:er)?|transparent|empty)\.(?:gif|png|svg)/i;
const TRACKING_PIXEL = /facebook\.com\/tr|google-analytics\.com|googleads\.g\.doubleclick\.net|doubleclick\.net|googleadservices\.com|bat\.bing\.com|analytics\.twitter\.com|px\.ads\.linkedin\.com|\/pixel\?|[?&]noscript=1/i;

function cssUrls(style) {
  const out = [];
  const re = /url\(\s*(['"]?)([^'")]{1,2048})\1\s*\)/gi;
  let m;
  while ((m = re.exec(style.slice(0, 4000))) !== null) out.push(m[2].trim());
  return out;
}

const BUSINESS_TYPES = new Set(
  [
    'Organization', 'Corporation', 'LocalBusiness', 'ProfessionalService', 'HomeAndConstructionBusiness',
    'GeneralContractor', 'RoofingContractor', 'Plumber', 'Electrician', 'HVACBusiness', 'HousePainter',
    'Locksmith', 'MovingCompany', 'Store', 'ClothingStore', 'OnlineStore', 'Restaurant', 'FoodEstablishment',
    'CafeOrCoffeeShop', 'Bakery', 'BarOrPub', 'FastFoodRestaurant', 'MedicalBusiness', 'MedicalClinic',
    'MedicalOrganization', 'Dentist', 'Physician', 'Optician', 'Pharmacy', 'HealthAndBeautyBusiness',
    'BeautySalon', 'HairSalon', 'DaySpa', 'NailSalon', 'HealthClub', 'LegalService', 'Attorney', 'Notary',
    'FinancialService', 'AccountingService', 'InsuranceAgency', 'RealEstateAgent', 'AutomotiveBusiness',
    'AutoRepair', 'AutoDealer', 'LodgingBusiness', 'Hotel', 'TravelAgency', 'EducationalOrganization',
    'SportsActivityLocation', 'EntertainmentBusiness', 'EmploymentAgency', 'ChildCare', 'DryCleaningOrLaundry',
    'Florist', 'HomeGoodsStore', 'FurnitureStore', 'JewelryStore', 'NGO', 'Service',
  ].map((t) => t.toLowerCase()),
);
const BUSINESS_TYPE_LIKE = /(business|store|shop|restaurant|service|services|contractor|clinic|agency|salon|organization|organisation|company|dentist|attorney)$/i;

function isBusinessType(type) {
  const t = String(type).replace(/^https?:\/\/schema\.org\//i, '').trim();
  return BUSINESS_TYPES.has(t.toLowerCase()) || BUSINESS_TYPE_LIKE.test(t);
}

function resolveAgainst(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

const SEARCH_FIELD_NAMES = new Set(['q', 's', 'search', 'query', 'keyword', 'keywords', 'term']);
const FIELD_TYPES_IGNORED = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);
// Forms and booking tools that are drawn by a script or an iframe, so the page's
// own HTML has no <form>. Shown as "Found a <label> form." Keep every pattern
// free of unbounded wildcards (".*"): they run over the whole page.
const FORM_PROVIDERS = [
  ['Typeform', /typeform\.com\/(?:to|embed)|embed\.typeform\.com/i],
  ['Jotform', /jotform\.(?:com|us)\/|form\.jotform/i],
  ['Google', /docs\.google\.com\/forms|forms\.gle\//i],
  ['HubSpot', /js\.hsforms\.net|hbspt\.forms\.create|share\.hsforms\.com/i],
  ['Wufoo', /wufoo\.com\/(?:forms|embed)/i],
  ['Formstack', /formstack\.com\/forms/i],
  ['Cognito', /cognitoforms\.com/i],
  ['Tally', /tally\.so\/(?:r|embed)\//i],
  ['Zoho', /forms\.zohopublic\.|zfvsform/i],
  // Squarespace draws its form blocks with JavaScript.
  ['Squarespace', /sqs-block-form|data-sqsp-block="form"/i],
  // Online booking / request-a-quote tools that home-service businesses use instead of a form.
  ['ServiceTitan booking', /scheduler\.servicetitan\.com/i],
  ['Housecall Pro booking', /online-booking\.housecallpro\.com|housecallpro\.com\/book/i],
  ['Jobber', /clienthub\.getjobber\.com|work_request_embed/i],
  ['Calendly booking', /assets\.calendly\.com\/assets\/external\/widget|calendly-inline-widget/i],
  ['Acuity booking', /embed\.acuityscheduling\.com|app\.acuityscheduling\.com\/schedule/i],
  ['Square booking', /squareup\.com\/appointments\/(?:book|buyer)/i],
];

// Everything the checks need, read from the HTML in one pass.
export function analyzeHtml(html, pageUrl) {
  const page = pageUrl instanceof URL ? pageUrl : new URL(String(pageUrl));
  const facts = {
    title: null,
    metaDescription: null,
    viewport: null,
    h1s: [],
    telLinks: [],
    whatsappLinks: 0,
    forms: [],
    og: {},
    jsonLdTypes: [],
    jsonLdBlocks: 0,
    microdataTypes: [],
    images: [],
    imageTags: 0,
    inlineImages: 0,
    textLength: 0,
    scripts: 0, // <script> elements that run (not JSON data)
    baseHref: null,
    generator: null,
    scriptTel: null, // a tap-to-call link that a script draws (menus, page builders, JSON)
    wix: null, // { metaSiteId, siteId } on Wix sites, which load tracking codes after the page
  };
  let svgDepth = 0;
  let h1Start = -1;
  let form = null;
  const imageUrls = [];
  const jsonLd = [];

  const addImage = (raw, from) => {
    if (!raw) return;
    const value = raw.trim();
    if (!value || value.startsWith('data:')) {
      if (value.startsWith('data:image')) facts.inlineImages += 1;
      return;
    }
    if (/^(?:blob|about|javascript):/i.test(value)) return;
    imageUrls.push({ raw: value, from });
  };

  scanHtml(html, {
    text(start, end) {
      if (svgDepth > 0) return;
      for (let k = start; k < end; k++) {
        if (!isSpaceCode(html.charCodeAt(k))) facts.textLength += 1;
      }
    },
    raw({ name, attrs, content }) {
      if (name === 'title' && svgDepth === 0 && facts.title === null) facts.title = cleanText(decodeEntities(content), 200);
      if (name === 'script' && /ld\+json/i.test(attrs.type || '')) jsonLd.push(content.slice(0, 100000));
      else if (name === 'script' && !/json|template|text\/html/i.test(attrs.type || '')) facts.scripts += 1;
    },
    tag(tag) {
      const { name, closing, attrs } = tag;
      if (name === 'svg') {
        svgDepth = closing ? Math.max(0, svgDepth - 1) : svgDepth + 1;
        return;
      }
      if (closing) {
        if (name === 'h1' && h1Start !== -1) {
          facts.h1s.push(stripTags(html.slice(h1Start, Math.min(tag.start, h1Start + 4000))));
          h1Start = -1;
        } else if (name === 'form' && form) {
          facts.forms.push(form);
          form = null;
        }
        return;
      }
      if (attrs.itemtype) {
        for (const t of attrs.itemtype.split(/\s+/)) {
          const m = /schema\.org\/([A-Za-z]+)/i.exec(t);
          if (m) facts.microdataTypes.push(m[1]);
        }
      }
      if (attrs.style && /url\(/i.test(attrs.style)) {
        for (const u of cssUrls(attrs.style)) addImage(u, 'style');
      }
      switch (name) {
        case 'base':
          if (attrs.href && facts.baseHref === null) facts.baseHref = attrs.href;
          break;
        case 'meta': {
          const key = (attrs.name || attrs.property || attrs['http-equiv'] || '').toLowerCase().trim();
          const content = attrs.content ?? '';
          if (key === 'description' && facts.metaDescription === null) facts.metaDescription = cleanText(content, 400);
          else if (key === 'viewport' && facts.viewport === null) facts.viewport = cleanText(content, 200);
          else if (key.startsWith('og:') && !(key in facts.og)) facts.og[key] = cleanText(content, 300);
          else if (key === 'generator' && facts.generator === null) facts.generator = cleanText(content, 80);
          break;
        }
        case 'h1':
          if (svgDepth === 0) h1Start = tag.end;
          break;
        case 'a': {
          const href = (attrs.href || '').trim();
          if (/^tel:/i.test(href)) {
            const number = cleanText(decodeURIComponentSafe(href.slice(4)), 40);
            if (number.replace(/\D/g, '').length >= 5) facts.telLinks.push(number);
          } else if (/^(?:https?:)?\/\/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|(?:www\.)?whatsapp\.com\/send)/i.test(href) || /^whatsapp:/i.test(href)) {
            facts.whatsappLinks += 1;
          }
          break;
        }
        case 'form': {
          const hint = `${attrs.role || ''} ${attrs.action || ''} ${attrs.id || ''} ${attrs.class || ''} ${attrs.name || ''}`;
          form = {
            fields: 0,
            textareas: 0,
            emails: 0,
            tels: 0,
            passwords: 0,
            search: /search/i.test(hint),
            // Shop baskets, logins and accounts aren't ways to ask for a quote.
            ignored: /cart|checkout|log-?in|sign-?in|account|password|register/i.test(hint),
            signup: /subscribe|newsletter|mailchimp|klaviyo|mc-embedded/i.test(hint),
            names: [],
          };
          break;
        }
        case 'input':
        case 'textarea':
        case 'select': {
          if (!form) break;
          const type = (attrs.type || (name === 'input' ? 'text' : name)).toLowerCase();
          if (name === 'input' && FIELD_TYPES_IGNORED.has(type)) break;
          if (type === 'search') form.search = true;
          if (type === 'password') form.passwords += 1;
          form.fields += 1;
          if (name === 'textarea') form.textareas += 1;
          if (type === 'email') form.emails += 1;
          if (type === 'tel') form.tels += 1;
          form.names.push((attrs.name || attrs.id || '').toLowerCase());
          break;
        }
        case 'img': {
          facts.imageTags += 1;
          const w = Number.parseInt(attrs.width, 10);
          const h = Number.parseInt(attrs.height, 10);
          if ((w > 0 && w <= 2) || (h > 0 && h <= 2)) break; // tracking pixel
          const lazy = attrs['data-src'] || attrs['data-lazy-src'] || attrs['data-original'] || attrs['data-lazy'];
          const src = attrs.src && !PLACEHOLDER_SRC.test(attrs.src.trim()) ? attrs.src : null;
          // A phone downloads from srcset whenever there is one (src is only the
          // fallback, and is often the biggest size), so weigh the srcset size a
          // phone would pick. Lazy-loaders park a placeholder in srcset and the
          // real list in data-srcset / data-lazy-srcset.
          // A <picture>'s <source> candidates aren't counted: only one gets downloaded, and its <img> is.
          let fromSrcset = null;
          for (const set of [attrs.srcset, attrs['data-srcset'], attrs['data-lazy-srcset']]) {
            const pick = set ? pickSrcsetCandidate(parseSrcset(set), attrs.sizes) : null;
            if (pick && !PLACEHOLDER_SRC.test(pick.trim())) {
              fromSrcset = pick;
              break;
            }
          }
          const chosen = fromSrcset || src || lazy;
          if (chosen) addImage(chosen, 'img');
          else if (attrs.src && attrs.src.trim().startsWith('data:image')) facts.inlineImages += 1;
          break;
        }
        case 'link': {
          const rel = (attrs.rel || '').toLowerCase();
          if (rel.includes('preload') && (attrs.as || '').toLowerCase() === 'image') {
            addImage(attrs.href || (attrs.imagesrcset ? pickSrcsetCandidate(parseSrcset(attrs.imagesrcset), attrs.imagesizes) : ''), 'preload');
          }
          break;
        }
        default:
          break;
      }
    },
  });
  if (form) facts.forms.push(form); // unclosed form at the end of the page

  // Structured data: read the @type values without needing perfectly valid JSON.
  facts.jsonLdBlocks = jsonLd.length;
  for (const block of jsonLd) {
    const re = /"@type"\s*:\s*(\[[^\]]{0,2000}\]|"[^"]{1,200}")/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      const raw = m[1];
      const names = raw.startsWith('[') ? raw.match(/"[^"]{1,200}"/g) || [] : [raw];
      for (const quoted of names) facts.jsonLdTypes.push(quoted.slice(1, -1));
    }
  }
  facts.jsonLdTypes = [...new Set(facts.jsonLdTypes)].slice(0, 20);
  facts.microdataTypes = [...new Set(facts.microdataTypes)].slice(0, 20);

  // Images: absolute, de-duplicated, tracking pixels dropped.
  const base = (facts.baseHref && resolveAgainst(facts.baseHref, page)) || page;
  const seen = new Set();
  for (const { raw, from } of imageUrls) {
    const u = resolveAgainst(raw, base);
    if (!u || TRACKING_PIXEL.test(u.href) || seen.has(u.href)) continue;
    seen.add(u.href);
    facts.images.push({ url: u.href, from });
  }

  // Tags and pixels: plain string searches over the whole page, scripts included.
  facts.tracking = findTracking(html);
  facts.whatsappInScripts = /wa\.me\/\d|api\.whatsapp\.com\/send|whatsapp\.com\/send\?phone/i.test(html);
  facts.formProviders = FORM_PROVIDERS.filter(([, re]) => re.test(html)).map(([label]) => label);
  if (!facts.telLinks.length) facts.scriptTel = findScriptTel(html);
  if (/wix\.com/i.test(facts.generator || '')) {
    const metaSiteId = /"metaSiteId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(html);
    const siteId = /"siteId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(html);
    facts.wix = metaSiteId && siteId ? { metaSiteId: metaSiteId[1], siteId: siteId[1] } : { metaSiteId: null, siteId: null };
  }
  return facts;
}

// A tap-to-call link that isn't an <a href="tel:"> in the HTML yet: menus and
// page builders often draw it with a script from JSON ("href":"tel:+1512...").
// Lower-case "tel:" right after a quote or "=" and straight into the number, so
// a printed label like "Tel: 512 555 0100" doesn't count. Squarespace's phone
// "Call" bar is drawn from its site settings.
function findScriptTel(html) {
  const re = /["'=]tel:(?:\/\/)?((?:\+|%2B)?\d[\d().\s%-]{5,22}\d)/g;
  let m;
  for (let tries = 0; tries < 50 && (m = re.exec(html)) !== null; tries++) {
    if (html.lastIndexOf('<!--', m.index) > html.lastIndexOf('-->', m.index)) continue; // commented out
    const number = cleanText(decodeURIComponentSafe(m[1]), 30);
    if (number.replace(/\D/g, '').length >= 7) return number;
  }
  const sqsPhone = /"contactPhoneNumber"\s*:\s*"([^"\\]{5,40})"/.exec(html);
  if (sqsPhone && sqsPhone[1].replace(/\D/g, '').length >= 7 && /"isContactPhoneNumberEnabled"\s*:\s*true/.test(html)) {
    return cleanText(sqsPhone[1], 30);
  }
  return null;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function uniqueMatches(html, re, group = 0) {
  const out = new Set();
  let m;
  while ((m = re.exec(html)) !== null && out.size < 10) out.add(m[group]);
  return [...out];
}

// Tag managers other than Google's. They can carry Analytics, Ads and the Pixel,
// but what's inside them can't be seen from the page.
const OTHER_TAG_MANAGERS = [
  ['Adobe Launch', /assets\.adobedtm\.com/i],
  ['Tealium', /tags\.tiqcdn\.com/i],
  ['Segment', /cdn\.segment\.com/i],
];

export function findTracking(html) {
  // The ids can sit inside escaped JSON too (Shopify's Google channel writes
  // \"G-ABC123\"), so a backslash may follow the id.
  const ga4 = uniqueMatches(html, /(?:[?&]id=|['"])(G-[A-Z0-9]{6,12})(?=[\\'"&\s]|$)/g, 1);
  const ua = uniqueMatches(html, /(?:[?&]id=|['"])(UA-\d{4,10}-\d{1,4})(?=[\\'"&\s]|$)/g, 1);
  const gtm = uniqueMatches(html, /\b(GTM-[A-Z0-9]{4,10})\b/g, 1);
  const ads = uniqueMatches(html, /\b(AW-\d{6,12})\b/g, 1);
  // gtag.js loaded with only an AW- id is the Google Ads tag, not Analytics;
  // a GT- id is a combined Google tag, which normally carries Analytics.
  const googleTags = uniqueMatches(html, /\b(GT-[A-Z0-9]{6,12})\b/g, 1);
  const gtmJs = /googletagmanager\.com\/gtm\.js/i.test(html);
  const analyticsJs = /google-analytics\.com\/(?:analytics|ga)\.js|google-analytics\.com\/g\/collect/i.test(html);
  const pixelJs = /connect\.facebook\.net\/[^"'\s]{0,40}\/fbevents\.js/i.test(html);
  const pixelInit = /fbq\(\s*['"]init['"]/.test(html);
  const pixelImg = /facebook\.com\/tr\?[^"'\s]{0,40}id=\d/i.test(html);
  // Shopify's Facebook & Instagram app loads the Pixel from its own config:
  // {\"pixel_id\":\"123...\",\"pixel_type\":\"facebook_pixel\"}
  const pixelShopify = /pixel_type\\*"\s*:\s*\\*"facebook_pixel/.test(html);
  const pixelIds = uniqueMatches(html, /fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,20})['"]/g, 1);
  const otherTagManager = (OTHER_TAG_MANAGERS.find(([, re]) => re.test(html)) || [])[0] || null;
  const hasGoogleTagManager = gtm.length > 0 || gtmJs;
  return {
    ga4,
    ua,
    gtm: gtm.length ? gtm : gtmJs ? ['GTM'] : [],
    ads,
    googleTags,
    otherTagManager,
    hasAnalytics:
      ga4.length > 0 || ua.length > 0 || googleTags.length > 0 || hasGoogleTagManager || analyticsJs || Boolean(otherTagManager),
    hasTagManager: hasGoogleTagManager || Boolean(otherTagManager),
    hasMetaPixel: pixelJs || pixelInit || pixelImg || pixelShopify,
    pixelIds,
  };
}

// ---------------------------------------------------------------------------
// Images: weigh up to 25 with HEAD, or a one-byte range request
// ---------------------------------------------------------------------------
const IMAGE_HEADERS = { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };

function headerNumber(value) {
  const n = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function contentRangeTotal(value) {
  const m = /\/(\d+)\s*$/.exec(String(value || ''));
  return m ? Number(m[1]) : null;
}

function fileName(href) {
  try {
    const u = new URL(href);
    // Image optimisers (Next.js /_next/image?url=..., ?src=...) carry the real file in the query.
    const inner = u.searchParams.get('url') || u.searchParams.get('src');
    const path = inner ? inner.split(/[?#]/)[0] : u.pathname;
    const last = path.split('/').filter(Boolean).pop() || u.hostname;
    return cleanText(decodeURIComponentSafe(last), 60);
  } catch {
    return 'image';
  }
}

async function weighImage(href, ctx) {
  const common = {
    readBody: false,
    timeoutMs: ctx.timeoutMs(),
    signal: ctx.signal,
    resolve: ctx.deps.resolve,
    isAllowed: ctx.deps.isAllowed,
    transport: ctx.deps.transport,
    cache: ctx.dnsCache,
  };
  let status = 0;
  try {
    const head = await safeFetch(href, { ...common, method: 'HEAD', headers: IMAGE_HEADERS });
    status = head.status;
    const length = headerNumber(head.headers['content-length']);
    if (head.status >= 200 && head.status < 300 && length !== null && length > 0) return { url: href, bytes: length };
    if (head.status === 404 || head.status === 410) return { url: href, bytes: null, broken: true };
  } catch (error) {
    if (error instanceof GuardError) return { url: href, bytes: null, refused: true };
  }
  if (ctx.signal && ctx.signal.aborted) return { url: href, bytes: null };
  try {
    const ranged = await safeFetch(href, {
      ...common,
      timeoutMs: ctx.timeoutMs(),
      method: 'GET',
      headers: { ...IMAGE_HEADERS, range: 'bytes=0-0' },
    });
    if (ranged.status === 206) {
      const total = contentRangeTotal(ranged.headers['content-range']);
      if (total !== null) return { url: href, bytes: total };
    }
    if (ranged.status >= 200 && ranged.status < 300) {
      const length = headerNumber(ranged.headers['content-length']);
      if (length !== null && length > 0) return { url: href, bytes: length };
    }
    status = ranged.status || status;
  } catch {
    /* unknown size */
  }
  return { url: href, bytes: null, broken: status === 404 || status === 410 };
}

export async function measureImages(images, { deadline, signal, deps = {}, dnsCache } = {}) {
  const list = images.slice(0, MAX_IMAGES);
  const phaseEnd = Math.min(deadline || Date.now() + IMAGE_PHASE_MS, Date.now() + IMAGE_PHASE_MS);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, Math.max(0, phaseEnd - Date.now()));
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  const ctx = {
    signal: controller.signal,
    deps,
    dnsCache: dnsCache || new Map(),
    timeoutMs: () => Math.max(500, Math.min(IMAGE_TIMEOUT_MS, phaseEnd - Date.now())),
  };
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      if (controller.signal.aborted) {
        results[index] = { url: list[index].url, bytes: null };
        continue;
      }
      try {
        results[index] = await weighImage(list[index].url, ctx);
      } catch {
        results[index] = { url: list[index].url, bytes: null };
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, list.length) }, worker));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
  }
  const measured = results.filter((r) => r && Number.isFinite(r.bytes));
  const totalBytes = measured.reduce((sum, r) => sum + r.bytes, 0);
  const heaviest = [...measured]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((r) => ({ name: fileName(r.url), bytes: r.bytes }));
  return {
    found: images.length,
    checked: list.length,
    measured: measured.length,
    totalBytes,
    heaviest,
    broken: results.filter((r) => r && r.broken).length,
  };
}

// ---------------------------------------------------------------------------
// Google PageSpeed Insights (optional)
// ---------------------------------------------------------------------------
export function parsePageSpeed(data) {
  const lr = data && data.lighthouseResult;
  const score = lr && lr.categories && lr.categories.performance && lr.categories.performance.score;
  if (!lr || lr.runtimeError || typeof score !== 'number') return { available: false, reason: 'no_score' };
  const audit = (id) => {
    const a = lr.audits && lr.audits[id];
    return a && typeof a.numericValue === 'number' ? a.numericValue : null;
  };
  return {
    available: true,
    performance: Math.round(score * 100),
    lcpMs: audit('largest-contentful-paint'),
    cls: audit('cumulative-layout-shift'),
    totalBytes: audit('total-byte-weight'),
  };
}

export async function runPageSpeed(pageUrl, apiKey, { signal, timeoutMs = PAGESPEED_TIMEOUT_MS, fetchImpl } = {}) {
  if (!apiKey) return { available: false, reason: 'no_key' };
  const doFetch = fetchImpl || globalThis.fetch;
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', pageUrl);
  api.searchParams.set('strategy', 'mobile');
  api.searchParams.set('category', 'performance');
  api.searchParams.set('key', apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  const stop = () => controller.abort();
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  try {
    const res = await doFetch(api, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (res.status === 429) return { available: false, reason: 'quota' };
    if (!res.ok) return { available: false, reason: `http_${res.status}` };
    return parsePageSpeed(await res.json());
  } catch (error) {
    // Never pass the error on: Google's URL carries the API key.
    return { available: false, reason: error && error.name === 'AbortError' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
  }
}

// ---------------------------------------------------------------------------
// Facts -> checks
// ---------------------------------------------------------------------------
function quote(text, max = 70) {
  return `“${cleanText(text, max)}”`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

function heaviestList(images) {
  return images.heaviest
    .filter((h) => h.bytes >= HEAVY_IMAGE_FILE_BYTES)
    .map((h) => `${h.name} (${formatBytes(h.bytes)})`)
    .join(', ');
}

// width=device-width fits any phone. So does a phone-sized fixed width (Wix's
// mobile sites use width=320 and the browser scales it to the screen), and an
// initial-scale=1 with no width. A desktop width (width=1024) shows zoomed out.
export function viewportFitsPhones(viewport) {
  const width = /(?:^|[\s,;])width\s*=\s*([\w.-]{1,20})/i.exec(viewport);
  if (width) {
    const value = width[1].toLowerCase();
    return value === 'device-width' || (/^\d{1,4}$/.test(value) && Number(value) <= 480);
  }
  return /initial-scale\s*=\s*1(?:\.0*)?(?![\d.])/i.test(viewport);
}

// Almost no text in a page that isn't tiny, and scripts to draw it: it's drawn
// by JavaScript after it loads.
export function isScriptDrawn(facts, page) {
  return facts.textLength < 200 && page.htmlBytes > 5000 && facts.scripts > 0;
}

export function evaluateChecks({ facts, page, images, speed }) {
  const t = facts.tracking;
  const results = {};

  // ---- Speed ----
  if (speed && speed.available) {
    const s = speed.performance;
    const bits = [`Google’s mobile speed score: ${s}/100.`];
    if (Number.isFinite(speed.lcpMs)) bits.push(`Main content shows after ${seconds(speed.lcpMs)} (aim for under 2.5 s).`);
    if (Number.isFinite(speed.cls)) bits.push(`Layout shift ${speed.cls.toFixed(2)} (aim for under 0.1).`);
    if (Number.isFinite(speed.totalBytes)) bits.push(`Page weight ${formatBytes(speed.totalBytes)}.`);
    results.speed_score = {
      status: s >= 90 ? 'pass' : s >= 50 ? 'warn' : 'fail',
      credit: Math.max(0, Math.min(1, s / 100)),
      detail: bits.join(' '),
      fix: `Make the page load faster on phones: Google scores it ${s}/100. Start with smaller images and fewer heavy scripts and plugins.`,
    };
  } else {
    results.speed_score = {
      status: 'skipped',
      detail: 'Speed test unavailable right now. We checked your image weight instead.',
    };
  }

  if (images.found === 0) {
    results.image_weight = { status: 'pass', detail: 'No images that slow the page down.' };
  } else if (images.measured === 0) {
    results.image_weight = {
      status: 'skipped',
      detail: `Found ${images.found} image${images.found === 1 ? '' : 's'}, but couldn’t weigh them.`,
    };
  } else {
    const total = formatBytes(images.totalBytes);
    const partial = images.found > images.checked ? ` (we weighed the first ${images.checked} of ${images.found})` : '';
    const atLeast = images.found > images.measured ? 'at least ' : 'about ';
    const heavy = heaviestList(images);
    const heavyText = heavy ? ` Heaviest: ${heavy}.` : '';
    if (images.totalBytes > HEAVY_IMAGES_BYTES) {
      results.image_weight = {
        status: 'fail',
        detail: `${images.found} images add up to ${atLeast}${total}${partial}. That’s heavy for a phone.${heavyText}`,
        fix: `Shrink your images: they add up to ${atLeast}${total}. Resize and compress them (WebP is best)${heavy ? `, starting with ${heavy.split(', ')[0]}` : ''}.`,
      };
    } else if (images.totalBytes > OK_IMAGES_BYTES) {
      results.image_weight = {
        status: 'warn',
        detail: `${images.found} images add up to ${atLeast}${total}${partial}. Aim for under 1.5 MB.${heavyText}`,
        fix: `Compress your images: they add up to ${atLeast}${total}. Aim for under 1.5 MB${heavy ? `, starting with ${heavy.split(', ')[0]}` : ''}.`,
      };
    } else {
      results.image_weight = {
        status: 'pass',
        detail: `${images.found} image${images.found === 1 ? '' : 's'}, ${atLeast}${total} in all${partial}.`,
      };
    }
  }

  const kb = Math.round(page.htmlBytes / 1024);
  if (page.truncated) {
    results.html_size = {
      status: 'fail',
      detail: 'Over 2 MB of page code before images. Phones have to download and read all of it first.',
      fix: 'Trim the page code (over 2 MB). Remove unused page-builder sections, plugins and inline code.',
    };
  } else if (page.htmlBytes > 800 * 1024) {
    results.html_size = {
      status: 'fail',
      detail: `${kb} KB of page code before images. Phones have to download and read all of it first.`,
      fix: `Trim the page code (${kb} KB). Remove unused page-builder sections, plugins and inline code.`,
    };
  } else if (page.htmlBytes > 300 * 1024) {
    results.html_size = {
      status: 'warn',
      detail: `${kb} KB of page code before images. Page builders and plugins often add this.`,
      fix: `Trim the page code (${kb} KB). Remove unused page-builder sections, plugins and inline code.`,
    };
  } else {
    results.html_size = { status: 'pass', detail: `${Math.max(1, kb)} KB of page code. Nice and light.` };
  }

  // ---- Mobile & SEO basics ----
  if (page.finalUrl.protocol === 'https:') {
    results.https = { status: 'pass', detail: 'Your site loads securely over HTTPS.' };
  } else {
    results.https = {
      status: 'fail',
      detail: page.httpsFailed
        ? 'Your site didn’t load over HTTPS, so browsers mark it “Not secure”.'
        : 'Your site stays on http://, so browsers mark it “Not secure”.',
      fix: 'Turn on HTTPS and send every visitor to it, so browsers stop showing “Not secure”. Most hosts do this free.',
    };
  }

  const vp = facts.viewport;
  if (vp && viewportFitsPhones(vp)) {
    results.viewport = { status: 'pass', detail: 'Set up to fit phone screens.' };
  } else if (vp) {
    results.viewport = {
      status: 'warn',
      detail: 'Has a viewport tag, but not the usual width=device-width, so phones may show it zoomed out.',
      fix: 'Set the mobile viewport tag to width=device-width so the site fits phone screens.',
    };
  } else {
    results.viewport = {
      status: 'fail',
      detail: 'No mobile viewport tag, so phones show a shrunk-down desktop page.',
      fix: 'Make the site fit phone screens: add the mobile viewport tag and check every page on a phone.',
    };
  }

  const title = facts.title;
  const titleLength = title ? Array.from(title).length : 0;
  if (!title) {
    results.title = {
      status: 'fail',
      detail: 'No page title. Google and browser tabs show your web address instead.',
      fix: 'Add a page title that says what you do and where, like “Roof Repair in Austin | Smith Roofing”.',
    };
  } else if (titleLength < 15) {
    results.title = {
      status: 'warn',
      detail: `Your title is very short: ${quote(title)}. Say what you do and where.`,
      fix: 'Make your page title say what you do and where, like “Roof Repair in Austin | Smith Roofing”.',
    };
  } else if (titleLength > 65) {
    results.title = {
      status: 'warn',
      detail: `Your title is ${titleLength} characters; Google cuts it off after about 60.`,
      fix: 'Shorten your page title to about 60 characters, so Google shows all of it.',
    };
  } else {
    results.title = { status: 'pass', detail: `${quote(title)} (${titleLength} characters).` };
  }

  const desc = facts.metaDescription;
  const descLength = desc ? Array.from(desc).length : 0;
  if (!desc) {
    results.meta_description = {
      status: 'fail',
      detail: 'Missing, so Google picks any text from the page for your search listing.',
      fix: 'Write a search description: one or two sentences on what you do, where, and why to call you.',
    };
  } else if (descLength < 50) {
    results.meta_description = {
      status: 'warn',
      detail: `Only ${descLength} characters. Give searchers a reason to click.`,
      fix: 'Write a fuller search description (about 120-155 characters): what you do, where, and why to call.',
    };
  } else if (descLength > 170) {
    results.meta_description = {
      status: 'warn',
      detail: `${descLength} characters; Google cuts it off after about 160.`,
      fix: 'Shorten your search description to about 155 characters, so Google shows all of it.',
    };
  } else {
    results.meta_description = { status: 'pass', detail: `Found (${descLength} characters).` };
  }

  const h1s = facts.h1s.filter(Boolean);
  if (h1s.length === 1) {
    results.h1 = { status: 'pass', detail: `Headline: ${quote(h1s[0])}.` };
  } else if (h1s.length > 1) {
    results.h1 = {
      status: 'warn',
      detail: `${h1s.length} main headlines (H1) on one page. One clear headline works best.`,
      fix: 'Use one main headline (H1) per page and turn the others into subheadings.',
    };
  } else {
    results.h1 = {
      status: 'fail',
      detail: 'No main headline (H1). Visitors and Google should see what you do straight away.',
      fix: 'Add one clear headline at the top that says what you do and where.',
    };
  }

  const types = [...new Set([...facts.jsonLdTypes, ...facts.microdataTypes])];
  const businessTypes = types.filter(isBusinessType);
  if (businessTypes.length) {
    results.structured_data = { status: 'pass', detail: `Found ${cleanText(businessTypes.slice(0, 3).join(', '), 80)} details for Google.` };
  } else if (types.length) {
    results.structured_data = {
      status: 'warn',
      detail: `Has schema (${cleanText(types.slice(0, 3).join(', '), 60)}), but nothing that describes your business.`,
      fix: 'Add LocalBusiness schema with your name, address, phone and hours, so Google shows the right details.',
    };
  } else {
    results.structured_data = {
      status: 'fail',
      detail: 'No business details for Google (LocalBusiness or Organization schema).',
      fix: 'Add LocalBusiness schema with your name, address, phone and hours, so Google shows the right details.',
    };
  }

  const og = facts.og;
  const ogCount = Object.keys(og).length;
  if (og['og:title'] && og['og:image']) {
    results.open_graph = { status: 'pass', detail: 'Shared links show a title and a picture.' };
  } else if (ogCount) {
    results.open_graph = {
      status: 'warn',
      detail: `Some sharing tags, but no ${og['og:image'] ? 'title' : 'picture'}, so shared links look plain.`,
      fix: 'Add the missing Open Graph tags (title, description, picture) so shared links look trustworthy.',
    };
  } else {
    results.open_graph = {
      status: 'fail',
      detail: 'No sharing tags, so links shared on WhatsApp or Facebook show no picture.',
      fix: 'Add Open Graph tags (title, description, picture) so links shared on WhatsApp and Facebook look trustworthy.',
    };
  }

  // ---- Getting leads ----
  if (facts.telLinks.length) {
    results.click_to_call = { status: 'pass', detail: `Found: ${cleanText(facts.telLinks[0], 30)}.` };
  } else if (facts.scriptTel) {
    results.click_to_call = { status: 'pass', detail: `Found: ${cleanText(facts.scriptTel, 30)}.` };
  } else {
    results.click_to_call = {
      status: 'fail',
      detail: 'No tap-to-call number. On a phone, visitors have to copy your number by hand.',
      fix: 'Add a tap-to-call phone number at the top of every page. Most visitors are on phones.',
    };
  }

  const realForms = facts.forms.filter((f) => {
    if (f.search || f.ignored || f.passwords > 0 || f.fields === 0) return false;
    if (f.fields === 1 && SEARCH_FIELD_NAMES.has(f.names[0])) return false;
    return true;
  });
  const leadForm = realForms.find((f) => !f.signup && (f.textareas > 0 || f.tels > 0 || f.fields >= 2));
  if (leadForm) {
    results.contact_form = { status: 'pass', detail: 'Found a form visitors can send.' };
  } else if (facts.formProviders.length) {
    results.contact_form = { status: 'pass', detail: `Found a ${cleanText(facts.formProviders[0], 30)} form.` };
  } else if (realForms.length) {
    results.contact_form = {
      status: 'warn',
      detail: 'Only a one-box sign-up form, no form to ask for a quote.',
      fix: 'Add a short quote form (3 questions, not 9) so people who don’t want to call can still reach you.',
    };
  } else {
    results.contact_form = {
      status: 'fail',
      detail: 'No contact or quote form on this page.',
      fix: 'Add a short quote form (3 questions, not 9) so people who don’t want to call can still reach you.',
    };
  }

  if (facts.whatsappLinks > 0 || facts.whatsappInScripts) {
    results.whatsapp = { status: 'pass', detail: 'Found a WhatsApp chat link.' };
  } else {
    results.whatsapp = {
      status: 'fail',
      detail: 'No WhatsApp link. Many customers would rather message than call.',
      fix: 'Add a WhatsApp chat button so customers can message you in one tap.',
    };
  }

  // ---- Tracking ----
  // The tag manager that could be carrying the Ads tag or the Pixel out of sight.
  const tagManager = t.gtm.length ? 'Tag Manager' : t.otherTagManager ? `your tag manager (${t.otherTagManager})` : '';
  if (t.hasAnalytics) {
    const found = [];
    if (t.ga4.length) found.push(`Google Analytics (${t.ga4[0]})`);
    else if (t.googleTags.length) found.push(`a Google tag (${t.googleTags[0]})`);
    else if (t.ua.length) found.push(`old Universal Analytics (${t.ua[0]})`);
    if (t.gtm.length) found.push(t.gtm[0] !== 'GTM' ? `Tag Manager (${t.gtm[0]})` : 'Tag Manager');
    else if (t.otherTagManager) found.push(`a tag manager (${t.otherTagManager})`);
    if (!found.length) found.push('Google Analytics');
    results.analytics = { status: 'pass', detail: `Found ${found.join(' and ')}.` };
  } else {
    results.analytics = {
      status: 'fail',
      detail: 'No Google Analytics or Tag Manager, so you can’t see where visitors come from.',
      fix: 'Install Google Analytics (GA4) or Tag Manager so you can see which visits turn into customers.',
    };
  }

  if (t.ads.length) {
    results.google_ads_tag = { status: 'pass', detail: `Found (${t.ads.slice(0, 2).join(', ')}).` };
  } else if (tagManager) {
    results.google_ads_tag = {
      status: 'warn',
      detail: `Not on the page itself. It may be inside ${tagManager}, which we can’t see into.`,
      fix: `Check that Google Ads conversion tracking is set up inside ${tagManager}.`,
    };
  } else {
    results.google_ads_tag = {
      status: 'fail',
      detail: 'No Google Ads tag, so ad clicks that turn into calls and forms aren’t counted.',
      fix: 'Add the Google Ads tag with conversion tracking, so you know which ads bring calls and forms.',
    };
  }

  if (t.hasMetaPixel) {
    results.meta_pixel = { status: 'pass', detail: 'Found the Meta Pixel.' };
  } else if (tagManager) {
    results.meta_pixel = {
      status: 'warn',
      detail: `Not on the page itself. It may be inside ${tagManager}.`,
      fix: `Check that the Meta Pixel is set up inside ${tagManager}.`,
    };
  } else {
    results.meta_pixel = {
      status: 'fail',
      detail: 'No Meta Pixel, so Facebook and Instagram ads can’t be measured or retargeted.',
      fix: 'Add the Meta Pixel so Facebook and Instagram ads can be measured and retargeted.',
    };
  }

  // Wix adds tracking codes after the page loads. When we couldn't read them,
  // "missing" would be a guess, so the check is left out instead.
  if (t.unseen) {
    for (const id of ['analytics', 'google_ads_tag', 'meta_pixel']) {
      if (results[id].status === 'fail') {
        results[id] = {
          status: 'skipped',
          detail: `${t.unseen} adds tracking codes after the page loads, and we couldn’t read them this time, so this isn’t scored.`,
        };
      }
    }
  }

  // A page drawn by JavaScript after it loads may show a headline, a phone link,
  // a form or a WhatsApp button that isn't in its code yet: "couldn't check", not "missing".
  if (isScriptDrawn(facts, page)) {
    for (const id of ['h1', 'click_to_call', 'contact_form', 'whatsapp']) {
      if (results[id].status === 'fail') {
        results[id] = {
          status: 'skipped',
          detail: 'This page is drawn by JavaScript after it loads, so we couldn’t check this from its code.',
        };
      }
    }
  }

  return CHECKS.map((def) => ({ ...def, ...results[def.id] }));
}

// ---------------------------------------------------------------------------
// Checks -> score, grade, top 3 fixes
// ---------------------------------------------------------------------------
export function gradeFor(score) {
  if (score >= 90) return { grade: 'A', label: 'Strong' };
  if (score >= 80) return { grade: 'B', label: 'Good, with a few gaps' };
  if (score >= 70) return { grade: 'C', label: 'Needs work' };
  if (score >= 60) return { grade: 'D', label: 'Leaking leads' };
  return { grade: 'F', label: 'Losing leads' };
}

export function scoreChecks(checks) {
  let earned = 0;
  let possible = 0;
  for (const c of checks) {
    if (c.status === 'skipped' || c.status === undefined) continue;
    const credit = typeof c.credit === 'number' ? c.credit : CREDIT[c.status] ?? 0;
    earned += c.weight * credit;
    possible += c.weight;
  }
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  const { grade, label } = gradeFor(score);
  const topFixes = checks
    .filter((c) => (c.status === 'fail' || c.status === 'warn') && c.fix)
    .map((c) => ({ c, lost: c.weight * (1 - (typeof c.credit === 'number' ? c.credit : CREDIT[c.status] ?? 0)) }))
    .sort((a, b) => b.lost - a.lost || FIX_PRIORITY.indexOf(a.c.id) - FIX_PRIORITY.indexOf(b.c.id))
    .slice(0, 3)
    .map(({ c }) => ({ id: c.id, title: c.name, text: c.fix }));
  return { score, grade, gradeLabel: label, earned, possible, topFixes };
}

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------
const PAGE_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
};

class CheckError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isTlsOrConnectError(error) {
  const code = String((error && error.code) || '');
  return /CERT|TLS|SSL|EPROTO|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ERR_SSL/.test(code);
}

function describeFetchError(error) {
  if (error instanceof CheckError) return error;
  if (error instanceof GuardError) return new CheckError(error.code, error.message || plainMessage(error.code));
  const code = String((error && (error.code || error.name)) || '');
  if (/AbortError|TimeoutError|ETIMEDOUT|ESOCKETTIMEDOUT|ABORT_ERR/.test(code)) {
    return new CheckError('timeout', 'That website took too long to answer (over 10 seconds). It may be slow or down right now.');
  }
  if (/ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME/.test(code)) return new CheckError('dns', plainMessage('dns'));
  if (/CERT|TLS|SSL|EPROTO/.test(code)) {
    return new CheckError('tls', 'That website’s security certificate isn’t valid, so browsers would warn visitors away. We couldn’t check it.');
  }
  if (code === 'EBADBODY') return new CheckError('unreadable', 'We reached that website, but couldn’t read the page it sent back.');
  return new CheckError('unreachable', 'We couldn’t connect to that website. It may be down, or blocking automated checks.');
}

function statusError(status, headers) {
  if (status === 401 || status === 403 || status === 429 || (status === 503 && headers && headers['cf-mitigated'])) {
    return new CheckError(
      'blocked',
      `That website blocked our check (error ${status}). Some security settings block automated visits. Book a call and we’ll check it with you.`,
    );
  }
  if (status === 404 || status === 410) return new CheckError('not_found', `We couldn’t find that page (error ${status}). Please check the address.`);
  if (status >= 500) return new CheckError('server_error', `That website answered with a server error (${status}). It may be having problems right now.`);
  return new CheckError('http_error', `That website answered with an error (${status}).`);
}

function decodeBody(buffer, contentType) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '');
  let label = m ? m[1].toLowerCase() : 'utf-8';
  if (label === 'utf8') label = 'utf-8';
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function looksLikeHtml(text) {
  const head = text.slice(0, 1024).replace(/^\ufeff/, '').trimStart().toLowerCase();
  return head.startsWith('<') && /<(?:!doctype|html|head|body|meta|title|div|script|link)\b/.test(head);
}

async function fetchPage(url, ctx) {
  const res = await safeFetch(url, {
    method: 'GET',
    headers: PAGE_HEADERS,
    timeoutMs: PAGE_TIMEOUT_MS,
    maxBytes: PAGE_MAX_BYTES,
    signal: ctx.signal,
    resolve: ctx.deps.resolve,
    isAllowed: ctx.deps.isAllowed,
    transport: ctx.deps.transport,
    cache: ctx.dnsCache,
  });
  if (res.status < 200 || res.status >= 300) throw statusError(res.status, res.headers);
  const contentType = String(res.headers['content-type'] || '');
  const text = decodeBody(res.body, contentType);
  const htmlType = /html|xml/i.test(contentType);
  if (contentType && !htmlType && !looksLikeHtml(text)) {
    throw new CheckError('not_html', `That address isn’t a web page (it sent back ${cleanText(contentType.split(';')[0], 40)}).`);
  }
  if (!contentType && !looksLikeHtml(text)) throw new CheckError('not_html', 'That address isn’t a web page.');
  if (!text.trim()) throw new CheckError('empty', 'That page came back empty.');
  if (text.length < 200000 && BOT_WALL.test(text.slice(0, 65536))) {
    throw new CheckError(
      'blocked',
      'That website showed our check a security challenge instead of the page. Some security settings block automated visits. Book a call and we’ll check it with you.',
    );
  }
  return { html: text, finalUrl: res.url, redirects: res.redirects, htmlBytes: res.bytes, truncated: res.truncated };
}

// Firewalls that answer "200 OK" with a challenge page instead of the site
// (Cloudflare, Sucuri, Imperva, DDoS-Guard). Checking that page would report
// everything as missing.
const BOT_WALL =
  /<title>\s*(?:Just a moment\.\.\.|Attention Required! \| Cloudflare|DDoS-Guard|Checking your browser|Pardon Our Interruption)|window\._cf_chl_opt|sucuri_cloudproxy_js|Incapsula incident ID/i;

// Wix adds Google Analytics, Tag Manager, the Ads tag and the Pixel after the page
// loads, from the site's own tag list (the same request a browser makes). Returns
// the tags' code, or null if it can't be read.
export const WIX_TAGS_TIMEOUT_MS = 5000;
async function fetchWixTags(pageUrl, wix, { deps, dnsCache, signal }) {
  if (!wix.metaSiteId || !wix.siteId) return null;
  const url = new URL(`/_api/tag-manager/api/v1/tags/sites/${wix.metaSiteId}`, pageUrl);
  url.search = '';
  url.searchParams.set('wixSite', String(/\.wixsite\.com$/i.test(url.hostname)));
  url.searchParams.set('htmlsiteId', wix.siteId);
  const own = AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(WIX_TAGS_TIMEOUT_MS)]) : signal;
  try {
    const res = await safeFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: WIX_TAGS_TIMEOUT_MS,
      maxBytes: 512 * 1024,
      maxRedirects: 2,
      signal: own,
      resolve: deps.resolve,
      isAllowed: deps.isAllowed,
      transport: deps.transport,
      cache: dnsCache,
    });
    if (res.status !== 200 || res.truncated) return null;
    const data = JSON.parse(res.body.toString('utf8'));
    if (!data || !Array.isArray(data.tags)) return null;
    return data.tags.map((tag) => (tag && typeof tag.content === 'string' ? tag.content : '')).join('\n');
  } catch {
    return null;
  }
}

// input: { url, business }
// options: { pagespeedKey, budgetMs, deps: { resolve, isAllowed, transport, fetch } }
// Resolves { ok: true, ...report } or { ok: false, code, error }. Never throws.
export async function runGrowthCheck(input = {}, options = {}) {
  const started = Date.now();
  const deadline = started + (options.budgetMs || BUDGET_MS);
  const deps = options.deps || {};
  const normal = normalizeUrl(input.url);
  if (!normal.ok) return { ok: false, code: normal.code, error: normal.message };
  const url = normal.url;
  const business = cleanBusinessName(input.business) || url.hostname.replace(/^www\./i, '');

  const run = new AbortController();
  const budgetTimer = setTimeout(() => run.abort(), Math.max(0, deadline - Date.now()));
  const dnsCache = new Map();
  const ctx = { deps, dnsCache };
  let speedPromise = null;
  const speedAbort = new AbortController();
  try {
    // Refuse private/internal targets before anything else, Google included.
    const pageAbort = AbortSignal.any
      ? AbortSignal.any([run.signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)])
      : run.signal;
    ctx.signal = pageAbort;
    try {
      await resolveSafeAddresses(url, { resolve: deps.resolve, isAllowed: deps.isAllowed, cache: dnsCache, signal: pageAbort });
    } catch (error) {
      throw describeFetchError(error);
    }

    speedPromise = runPageSpeed(url.href, options.pagespeedKey, {
      signal: speedAbort.signal,
      timeoutMs: Math.min(PAGESPEED_TIMEOUT_MS, deadline - Date.now() - 1000),
      fetchImpl: deps.fetch,
    });

    let page;
    try {
      page = await fetchPage(url, ctx);
    } catch (error) {
      const failure = describeFetchError(error);
      // They typed a bare domain and HTTPS didn't work (bad certificate, nothing
      // listening, no answer at all, or a server error): see if plain http://
      // works, with its own 10 seconds.
      const httpsBroken = isTlsOrConnectError(error) || failure.code === 'timeout' || failure.code === 'server_error';
      if (normal.schemeAdded && url.protocol === 'https:' && httpsBroken && !run.signal.aborted) {
        const httpUrl = new URL(url.href);
        httpUrl.protocol = 'http:';
        const retrySignal = AbortSignal.any ? AbortSignal.any([run.signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]) : run.signal;
        try {
          page = await fetchPage(httpUrl, { ...ctx, signal: retrySignal });
          page.httpsFailed = true;
        } catch {
          throw failure;
        }
      } else {
        throw failure;
      }
    }

    const facts = analyzeHtml(page.html, page.finalUrl);
    const [images, wixTags] = await Promise.all([
      measureImages(facts.images, { deadline, signal: run.signal, deps, dnsCache }),
      facts.wix ? fetchWixTags(page.finalUrl, facts.wix, { deps, dnsCache, signal: run.signal }) : null,
    ]);
    if (facts.wix) {
      if (typeof wixTags === 'string') facts.tracking = findTracking(`${page.html}\n${wixTags}`);
      else facts.tracking.unseen = 'Wix';
    }
    const speed = await speedPromise;
    const checks = evaluateChecks({ facts, page, images, speed });
    const scored = scoreChecks(checks);

    const notes = [];
    if (page.httpsFailed) notes.push('Your site didn’t answer over HTTPS, so we checked the http:// version.');
    if (page.truncated) notes.push('The page is over 2 MB, so we read the first 2 MB.');
    if (isScriptDrawn(facts, page)) {
      notes.push('Most of this page is drawn by JavaScript after it loads, so we could only check what arrives first. Some search engines and link previews see it the same way.');
    }

    return {
      ok: true,
      business,
      url: url.href,
      finalUrl: page.finalUrl.href,
      redirected: page.redirects.length > 0,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      score: scored.score,
      grade: scored.grade,
      gradeLabel: scored.gradeLabel,
      topFixes: scored.topFixes,
      groups: GROUPS.map((g) => ({
        id: g.id,
        title: g.title,
        checks: checks
          .filter((c) => c.group === g.id)
          .map((c) => ({ id: c.id, name: c.name, status: c.status, detail: c.detail || '' })),
      })),
      speed: speed && speed.available
        ? { available: true, performance: speed.performance, lcpMs: speed.lcpMs, cls: speed.cls, totalBytes: speed.totalBytes }
        : { available: false, message: 'Speed test unavailable right now.' },
      images: {
        found: images.found,
        checked: images.checked,
        measured: images.measured,
        totalBytes: images.totalBytes,
        heaviest: images.heaviest,
      },
      html: { bytes: page.htmlBytes, truncated: page.truncated },
      notes,
    };
  } catch (error) {
    const failure = describeFetchError(error);
    return { ok: false, code: failure.code, error: failure.message };
  } finally {
    clearTimeout(budgetTimer);
    speedAbort.abort();
    if (speedPromise) speedPromise.catch(() => {});
  }
}
