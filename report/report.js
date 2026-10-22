// One-page website check for a business we contacted: /report/<slug>.
// The facts live in /report-data/<slug>.json (written when we checked the
// site); this script only lays them out. Everything goes in as text, never
// as HTML, and only our own paths are used for images and links.

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const SHOT_RE = /^\/report-data\/[a-z0-9-]+\.webp$/;
const DEMOS = new Set(['roofing', 'hvac', 'plumbing']);
const DEMO_WORDS = { roofing: 'roofing', hvac: 'heating and air', plumbing: 'plumbing' };
const EMAIL = 'info@digitaldominant.co.uk';

const $ = (key) => document.querySelector(`[data-r="${key}"]`);

function slugFromUrl() {
  let raw = '';
  const parts = location.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('report');
  if (at >= 0 && parts[at + 1] && parts[at + 1] !== 'index.html') raw = parts[at + 1];
  if (!raw) raw = new URLSearchParams(location.search).get('r') || '';
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return '';
  }
  const slug = raw.toLowerCase().replace(/\.html?$/, '');
  return SLUG_RE.test(slug) ? slug : '';
}

function text(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeSite(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function done() {
  document.getElementById('main')?.setAttribute('aria-busy', 'false');
}

function showMissing() {
  document.title = 'Report not found | Digital Dominant';
  $('kicker').textContent = 'Website check';
  $('title').textContent = 'We couldn’t find that report';
  $('intro').textContent = 'The link may have been cut off in your email app. Try opening the full link again.';
  $('missing').hidden = false;
  done();
}

function render(r) {
  const name = text(r.name, 80);
  const domain = text(r.domain, 80);
  const checked = text(r.checked, 40);
  const items = Array.isArray(r.items) ? r.items.filter((i) => i && i.title) : [];
  const good = Array.isArray(r.good) ? r.good.map((g) => text(g, 120)).filter(Boolean) : [];
  if (!name || !domain) throw new Error('incomplete report');

  document.title = `Website check: ${name} | Digital Dominant`;
  $('kicker').textContent = checked ? `Website check · ${checked}` : 'Website check';
  $('title').textContent = `${name}: your homepage on a phone`;
  const down = items.some((i) => i.key === 'down');
  $('intro').textContent = down
    ? `We tried to open ${domain} on a phone, the way a customer would. Here is what we saw and how to fix it.`
    : `We opened ${domain} on a phone and scrolled to the bottom, the way a customer would. ` +
      `Here is what stood out, how to fix it${good.length ? ', and what is already working' : ''}.`;

  const site = safeSite(r.website);
  const siteLink = $('site');
  if (site) {
    siteLink.href = site;
    siteLink.textContent = domain;
    $('links').hidden = false;
  }

  const shot = $('shot');
  if (SHOT_RE.test(String(r.shot || ''))) {
    shot.src = r.shot;
    shot.alt = `${domain} as it looked on a phone${checked ? ` on ${checked}` : ''}`;
    $('shot-caption').textContent = `${domain} on a phone${checked ? `, ${checked}` : ''}`;
  } else {
    shot.closest('figure').hidden = true;
    shot.closest('.rp-grid').classList.add('rp-no-shot');
  }

  const n = items.length;
  $('found-title').textContent = n
    ? `${n === 1 ? 'One thing' : `${n} things`} a customer would notice`
    : 'Nothing big stood out';

  const list = $('items');
  items.forEach((item) => {
    const li = el('li', `rp-item rp-${text(item.key, 20).replace(/[^a-z]/g, '') || 'other'}`);
    li.append(el('h3', null, text(item.title, 120)), el('p', null, text(item.detail)));
    list.append(li);
  });

  if (good.length) {
    const ul = $('good');
    good.forEach((g) => ul.append(el('li', null, g)));
    $('good-wrap').hidden = false;
  }

  $('how').textContent =
    `How we checked: a phone-sized browser, 360 pixels wide${checked ? `, on ${checked}` : ''}. ` +
    (items.some((i) => i.key === 'heavy') ? 'Page weight counts everything the homepage downloads while scrolling to the bottom. ' : '') +
    'If you have fixed something since, great: this page is a snapshot.';

  const seen = new Set();
  const fixes = items.filter((i) => i.fix && !seen.has(i.fixTitle || i.fix) && seen.add(i.fixTitle || i.fix));
  if (fixes.length) {
    const ol = $('fixes');
    fixes.forEach((item, i) => {
      const li = el('li', 'rp-fix');
      li.append(el('span', 'rp-n', String(i + 1)), el('h3', null, text(item.fixTitle || item.title, 80)), el('p', null, text(item.fix)));
      ol.append(li);
    });
    if (fixes.length === 1) {
      $('fix-title').textContent = 'The fix';
      $('fix-lead').textContent = 'Usually a quick job. Hand this page to whoever looks after your site, or ask us to do it.';
    }
    $('fixes-wrap').hidden = false;
  }

  const demo = DEMOS.has(r.demo) ? r.demo : 'roofing';
  const link = $('demo-link');
  if (DEMOS.has(r.demo)) {
    const city = text(r.city, 40);
    link.href = `/demos/${demo}?for=${encodeURIComponent(name)}${city ? `&city=${encodeURIComponent(city)}` : ''}`;
    $('demo-title').textContent = `See a fast ${DEMO_WORDS[demo]} site on your phone`;
    $('demo-text').textContent =
      `A sample ${DEMO_WORDS[demo]} site we built to show what fast feels like, set up with your name on it. ` +
      'It opens in about a second on cell data, the phone number is one tap, and the quote form is three quick questions.';
  } else {
    link.href = `/demos/${demo}`;
  }
  $('demo-wrap').hidden = false;

  $('mail').href = `mailto:${EMAIL}?subject=${encodeURIComponent(`Website check: ${name}`)}`;
  $('report').hidden = false;
  $('cta').hidden = false;
  done();
}

const slug = slugFromUrl();
if (!slug) {
  showMissing();
} else {
  fetch(`/report-data/${slug}.json`, { headers: { Accept: 'application/json' } })
    // A 404's body is read too, so the request finishes cleanly instead of being cut off mid-way.
    .then((res) => (res.ok ? res.json() : res.text().then(() => Promise.reject(new Error(String(res.status))))))
    .then(render)
    .catch(showMissing);
}
