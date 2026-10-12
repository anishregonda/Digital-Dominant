// Shared behaviour for every page: mobile menu, scroll animations, icons, the
// floating WhatsApp button, the lead forms (contact + book) that post to DD Hub,
// the Lead Leak Calculator and the Free Growth Check (which runs on this site's
// own /api/growth-check, not on the Hub).
//
// Lead forms never fake success: we only move on to the thank-you page when
// the Hub answers {ok:true}. Anything else (error, blocked, offline, or no
// answer within 6 seconds) hands the message to WhatsApp so no lead is lost.

const HUB = 'https://hub.digitaldominant.co.uk';
const SITE = 'digital-dominant';
const WHATSAPP_NUMBER = '919949932140';
const PHONE_DISPLAY = '+91\u00a099499\u00a032140'; // non-breaking spaces: never split the number
const LEAD_TIMEOUT_MS = 6000;

// encodeURIComponent throws on half an emoji (a lone surrogate), which would
// stop the WhatsApp fallback from opening; swap any such half for "?" first.
function wellFormed(text) {
  return Array.from(String(text), (ch) => (ch.length === 1 && ch >= '\ud800' && ch <= '\udfff' ? '?' : ch)).join('');
}

// At most `max` characters, never cutting an emoji in half; "…" shows it was cut.
function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

function waLink(text) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(wellFormed(text))}`;
}

// ---------------------------------------------------------------------------
// Mobile menu
// ---------------------------------------------------------------------------
function initMenu() {
  const button = document.getElementById('mobile-menu');
  const nav = document.getElementById('site-nav');
  if (!button || !nav) return;

  const setOpen = (open) => {
    button.classList.toggle('active', open);
    nav.classList.toggle('active', open);
    document.body.classList.toggle('menu-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };

  button.addEventListener('click', () => setOpen(!nav.classList.contains('active')));
  nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setOpen(false)));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('active')) {
      setOpen(false);
      button.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (!nav.classList.contains('active')) return;
    if (nav.contains(event.target) || button.contains(event.target)) return;
    setOpen(false);
  });

  // Back to desktop width: never leave the page stuck in "menu open" state.
  const desktop = window.matchMedia('(min-width: 901px)');
  const onChange = (mq) => {
    if (mq.matches) setOpen(false);
  };
  if (desktop.addEventListener) desktop.addEventListener('change', onChange);
  else if (desktop.addListener) desktop.addListener(onChange); // iOS 13 and older
}

// ---------------------------------------------------------------------------
// Icons + animations (both vendored under /vendor, loaded by each page)
// ---------------------------------------------------------------------------
function initIconsAndAnimations() {
  const drawIcons = () => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
      return true;
    }
    return false;
  };
  // icons.js is a deferred script; if it hasn't run yet, draw once the page has loaded.
  if (!drawIcons()) window.addEventListener('load', drawIcons, { once: true });

  if (window.AOS && typeof window.AOS.init === 'function') {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.AOS.init({ once: true, offset: 60, duration: 700, disable: reduceMotion });
  }
}

// ---------------------------------------------------------------------------
// Floating WhatsApp button: never on top of a page's own buttons
// ---------------------------------------------------------------------------
// Every button in the page's <main> (.btn, the Influencers Lab and thank-you
// page buttons, form buttons), plus button groups marked data-wa-avoid (e.g. a
// hero or closing CTA that already offers WhatsApp) and single button-style
// links marked data-wa-avoid (the contact card's "Book a free 30-minute call"
// has no .btn): while one of them passes under the floating button, the
// floating button steps aside (.is-tucked) so it never covers it. Single buttons
// count too: on a 320px phone a lone "Book a call" button can sit right under
// the floating button.
// The calculator's number fields and the qualifier's option chips sit on the
// right edge of a phone screen too, so the whole form counts.
const FLOAT_AVOID = '[data-wa-avoid] .btn, a[data-wa-avoid], main .btn, main .il-btn, main .thank-you-btn, main button, main .calc-form, main .q-form';

function initFloatAvoid() {
  const wa = document.querySelector('.wa-float');
  const buttons = [...document.querySelectorAll(FLOAT_AVOID)];
  if (!wa || !buttons.length) return;

  const GAP = 8; // px of breathing room around the floating button
  let queued = false;
  const update = () => {
    queued = false;
    const f = wa.getBoundingClientRect(); // tucking only fades it, so this box never moves
    const covered = buttons.some((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.right > f.left - GAP && r.left < f.right + GAP && r.bottom > f.top - GAP && r.top < f.bottom + GAP;
    });
    wa.classList.toggle('is-tucked', covered);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  window.addEventListener('load', queue, { once: true }); // fonts and images can move the buttons
  window.addEventListener('pageshow', queue); // back/forward cache: check again on return
  // The page can also move under a still screen: an FAQ answer opening or closing
  // slides the closing buttons up or down without any scroll. Watch the page's size.
  if (typeof ResizeObserver === 'function') new ResizeObserver(queue).observe(document.body);
  update();
}

// ---------------------------------------------------------------------------
// Lead forms
// ---------------------------------------------------------------------------
// Exactly the Hub's rules (dd-hub src/lib/website/clean.ts: cleanPhone, isPlainEmail).
// Anything the Hub would refuse must be caught here, or the visitor is told the
// form "didn't go through" and sent to WhatsApp for a typo they could fix.
const PHONE_RE = /^\(?\+?[\d\s().-]+$/;
const EMAIL_RE = /^[a-z0-9._+'-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,22}[a-z0-9]$/i;
const EMAIL_MAX = 120;

function value(form, name) {
  const field = form.elements.namedItem(name);
  return field && typeof field.value === 'string' ? field.value.trim() : '';
}

function fullPhone(form) {
  const number = value(form, 'phone');
  const code = value(form, 'country_code');
  // Already has a country code: "+91 98480 12345" or "(+91) 98480 12345"
  if (!number || !code || /^\(?\+/.test(number)) return number;
  const local = number.replace(/^0+/, '');
  // Someone typed the country code without "+" (e.g. 919876543210)
  const codeDigits = code.replace(/\D/g, '');
  if (local.replace(/\D/g, '').length > 10 && local.startsWith(codeDigits)) return `+${local}`;
  return `${code} ${local}`;
}

function readLead(form) {
  const name = value(form, 'name');
  // The message box is named "text" so that, if this script never runs, the
  // form's plain fallback (action = wa.me) still pre-fills WhatsApp.
  const messageField = form.querySelector('[data-lead-message]');
  const details = messageField ? messageField.value.trim() : value(form, 'message');
  const intro = form.dataset.leadIntro || '';
  // Optional fields the Hub has no column for (e.g. business name, the
  // qualifier's answers, the calculator's numbers) ride along in the message.
  // For a radio group only the picked option counts.
  const extras = [...form.querySelectorAll('[data-lead-extra]')]
    .filter((field) => field.type !== 'radio' || field.checked)
    .map((field) => [field.dataset.leadExtra, field.value.trim()])
    .filter(([, text]) => text)
    .map(([label, text]) => `${label}: ${text}`);
  return {
    name,
    phone: fullPhone(form),
    email: value(form, 'email'),
    message: [intro, extras.join('\n'), details].filter(Boolean).join('\n\n'),
    details,
    extras,
    website: value(form, 'website'), // honeypot: people never see it
  };
}

// Forms marked novalidate (the qualifier, the calculator's plan form) skip the
// browser's own checks, so required fields and radio groups are checked here.
function findMissing(form) {
  const seen = new Set();
  for (const field of form.querySelectorAll('[required]')) {
    if (field.type === 'radio') {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      const group = [...form.querySelectorAll('input[type="radio"]')].filter((r) => r.name === field.name);
      if (group.some((r) => r.checked)) continue;
      const fieldset = field.closest('fieldset');
      return { field, message: (fieldset && fieldset.dataset.leadMissing) || 'Please pick one of the options.' };
    }
    if (typeof field.value === 'string' && !field.value.trim()) {
      return { field, message: field.dataset.leadMissing || 'Please fill this in.' };
    }
  }
  return null;
}

function findProblem(form, lead) {
  if (form.hasAttribute('novalidate')) {
    const missing = findMissing(form);
    if (missing) return missing;
  }
  const digits = lead.phone.replace(/\D/g, '').length;
  const phoneField = form.elements.namedItem('phone');
  const emailField = form.elements.namedItem('email');
  // data-lead-contact="either": a phone number or an email address, whichever they prefer.
  const either = form.dataset.leadContact === 'either';
  if (either && phoneField && emailField && !lead.phone && !lead.email) {
    return { field: phoneField, message: 'Please add a phone number or an email address so we can reply.' };
  }
  const phoneNeeded = phoneField && !(either && !lead.phone);
  if (phoneNeeded && (!lead.phone || !PHONE_RE.test(lead.phone) || digits < 7 || digits > 15)) {
    return { field: phoneField, message: 'Please check your phone number. Use digits only, for example 98765 43210.' };
  }
  if (emailField && lead.email && (lead.email.length > EMAIL_MAX || !EMAIL_RE.test(lead.email))) {
    return { field: emailField, message: 'Please check your email address, or leave it empty.' };
  }
  return null;
}

function reveal(box) {
  // Make sure the message is on screen (it sits under the submit button).
  try {
    box.scrollIntoView({ block: 'nearest' });
  } catch {
    /* ignore */
  }
}

function setStatus(box, kind, text) {
  if (!box) return;
  box.className = `lead-status is-${kind}`;
  box.textContent = text;
  if (kind === 'error') reveal(box);
}

async function sendLead(lead) {
  const body = {
    site: SITE,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    message: lead.message,
    // The Hub keeps only the path; the query (gclid, utm_source) just tells it where the visit came from.
    page: location.pathname + location.search,
    website: lead.website,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEAD_TIMEOUT_MS);
  try {
    // text/plain keeps this a "simple" request (no CORS preflight); the Hub
    // parses the JSON body either way.
    const response = await fetch(`${HUB}/api/lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    const data = await response.json();
    return response.ok && data !== null && typeof data === 'object' && data.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function whatsappText(lead, form) {
  const lines = [form.dataset.waIntro || 'Hi Digital Dominant, I tried to send this from your website:'];
  if (lead.name) lines.push(`Name: ${lead.name}`);
  if (lead.phone) lines.push(`Phone: ${lead.phone}`);
  if (lead.email) lines.push(`Email: ${lead.email}`);
  lead.extras.forEach((line) => lines.push(line));
  if (lead.details) lines.push(`Message: ${clip(lead.details, 1200)}`);
  return lines.join('\n');
}

function fallbackToWhatsApp(form, box, lead) {
  const url = waLink(whatsappText(lead, form));

  if (box) {
    box.className = 'lead-status is-fallback';
    box.textContent = '';

    const note = document.createElement('p');
    note.textContent = "Sorry, our form didn't go through. We're opening WhatsApp with your message so it still reaches us. Just tap send.";

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'btn btn-wa';
    link.dataset.waFallback = '';
    link.textContent = 'Open WhatsApp';

    const alt = document.createElement('p');
    alt.className = 'lead-alt';
    alt.append('Or call us on ');
    const tel = document.createElement('a');
    tel.href = `tel:+${WHATSAPP_NUMBER}`;
    tel.textContent = PHONE_DISPLAY;
    alt.append(tel, '.');

    box.append(note, link, alt);
    reveal(box);
  }

  // Prefer a new tab so this page (and the message) stays open. If the
  // browser blocks that, go to WhatsApp in this tab instead.
  let win = null;
  try {
    win = window.open(url, '_blank');
  } catch {
    win = null;
  }
  if (win) {
    try {
      win.opener = null;
    } catch {
      /* ignore */
    }
  } else {
    setTimeout(() => {
      location.href = url;
    }, 1200);
  }
}

function initLeadForms() {
  document.querySelectorAll('form[data-lead-form]').forEach((form) => {
    const box = form.querySelector('[data-lead-status]');
    const button = form.querySelector('[type="submit"]');
    const label = button ? button.textContent : '';

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.dataset.sending === '1') return;

      const lead = readLead(form);
      const problem = findProblem(form, lead);
      if (problem) {
        setStatus(box, 'error', problem.message);
        problem.field.focus();
        return;
      }

      form.dataset.sending = '1';
      if (button) {
        button.disabled = true;
        button.textContent = 'Sending…';
      }
      setStatus(box, 'info', 'Sending your message…');

      const ok = await sendLead(lead);

      if (ok) {
        form.dataset.sent = '1';
        // data-success="inline": stay on the page (the calculator keeps its numbers
        // on screen) and swap the form for the thank-you block next to it.
        if (form.dataset.success === 'inline') {
          const thanks = document.getElementById(form.dataset.thanks || '');
          form.hidden = true;
          if (thanks) {
            thanks.hidden = false;
            try {
              thanks.focus({ preventScroll: false });
              thanks.scrollIntoView({ block: 'nearest' });
            } catch {
              /* ignore */
            }
          }
          return;
        }
        setStatus(box, 'info', 'Sent. Taking you to the next step…');
        location.assign(form.dataset.success || 'thank-you.html?type=enquiry');
        return;
      }

      form.dataset.sending = '';
      if (button) {
        button.disabled = false;
        button.textContent = label;
      }
      fallbackToWhatsApp(form, box, lead);
    });

    // Back button from the thank-you page: phones restore this page exactly as it
    // was left (button disabled, "Sending…"). Make the form usable again, and clear
    // the message that was already sent so a second tap can't send it twice.
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      const sent = form.dataset.sent === '1';
      form.dataset.sending = '';
      form.dataset.sent = '';
      if (button) {
        button.disabled = false;
        button.textContent = label;
      }
      if (sent) {
        form.reset();
        setStatus(box, 'info', "Sent. We'll get back to you within 24 hours.");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Lead Leak Calculator (calculator.html)
// ---------------------------------------------------------------------------
// Arithmetic on the visitor's own numbers, nothing else:
//   extra leads     = visitors × (target% − today%)
//   extra customers = extra leads × close%
//   worth a month   = extra customers × customer value
// The state lives in the URL query (?v=2000&cr=2&t=4&val=3000&close=25&cur=usd)
// so a prefilled link can be sent. No cookies, nothing stored anywhere.
// Caps keep a typo (an extra zero or three) from producing a figure that no
// longer fits on a phone screen: ten million visitors or ten million per customer.
const CALC_FIELDS = {
  v: { def: 2000, min: 0, max: 10000000, decimals: 0 },
  cr: { def: 2, min: 0, max: 100, decimals: 1 },
  t: { def: 4, min: 0, max: 100, decimals: 1 },
  val: { def: 3000, min: 0, max: 10000000, decimals: 0 },
  close: { def: 25, min: 0, max: 100, decimals: 0 },
};
const CALC_CURRENCIES = {
  usd: { code: 'USD', locale: 'en-US', symbol: '$', valueMax: 100000 },
  inr: { code: 'INR', locale: 'en-IN', symbol: '₹', valueMax: 1000000 },
};

function initCalculator() {
  const form = document.getElementById('calc');
  if (!form) return;

  const byId = (id) => document.getElementById(id);
  const num = (k) => byId(`n-${k}`);
  const range = (k) => byId(`r-${k}`);
  const keys = Object.keys(CALC_FIELDS);
  const state = {};
  let cur = 'usd';
  let urlTimer = 0;

  // A number inside the field's bounds, or `fallback` when the text isn't a number
  // at all (an empty field, "abc" in a shared link): never silently zero.
  const clampNum = (k, raw, fallback) => {
    const f = CALC_FIELDS[k];
    const n = Number.parseFloat(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(n)) return fallback === undefined ? f.min : fallback;
    const scale = 10 ** f.decimals;
    return Math.min(f.max, Math.max(f.min, Math.round(n * scale) / scale));
  };

  // Read the link first: a prospect may arrive with their numbers already in it.
  const params = new URLSearchParams(location.search);
  keys.forEach((k) => {
    state[k] = params.has(k) ? clampNum(k, params.get(k), CALC_FIELDS[k].def) : CALC_FIELDS[k].def;
  });
  if (params.get('cur') === 'inr') cur = 'inr';

  const money = () => CALC_CURRENCIES[cur];
  const fmtInt = (n) => new Intl.NumberFormat(money().locale, { maximumFractionDigits: 0 }).format(n);
  const fmtCount = (n) =>
    Math.abs(n) < 10 && Math.round(n) !== n
      ? new Intl.NumberFormat(money().locale, { maximumFractionDigits: 1 }).format(n)
      : fmtInt(n);
  const fmtMoney = (n) =>
    new Intl.NumberFormat(money().locale, { style: 'currency', currency: money().code, maximumFractionDigits: 0 }).format(n);
  const fmtPct = (n) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n)}%`;

  const buildQuery = () => {
    const q = new URLSearchParams();
    keys.forEach((k) => q.set(k, String(state[k])));
    q.set('cur', cur);
    return q.toString();
  };
  const buildUrl = () => `${location.origin}${location.pathname}?${buildQuery()}`;

  // Safari limits history.replaceState to 100 calls per 30 seconds and throws
  // past that; a slider drag fires far more input events. Write the URL a
  // moment after the last change instead of on every one.
  const writeUrl = () => {
    clearTimeout(urlTimer);
    urlTimer = 0;
    try {
      history.replaceState(null, '', `${location.pathname}?${buildQuery()}`);
    } catch {
      /* ignore: the Copy link button builds the URL from the state anyway */
    }
  };
  const scheduleUrl = () => {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(writeUrl, 250);
  };

  const paintRange = (k) => {
    const r = range(k);
    if (!r) return;
    const min = Number(r.min);
    const max = Number(r.max);
    const v = Math.min(max, Math.max(min, state[k]));
    r.value = String(v);
    r.style.setProperty('--p', `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
  };

  const syncInputs = (except) => {
    keys.forEach((k) => {
      const n = num(k);
      if (n && n !== except) n.value = String(state[k]);
      paintRange(k);
    });
  };

  const compute = () => {
    const leadsNow = (state.v * state.cr) / 100;
    const leadsTarget = (state.v * state.t) / 100;
    const extraLeads = Math.max(0, leadsTarget - leadsNow);
    const extraCustomers = (extraLeads * state.close) / 100;
    const month = extraCustomers * state.val;
    return { leadsNow, leadsTarget, extraLeads, extraCustomers, month, year: month * 12 };
  };

  const setText = (id, text) => {
    const el = byId(id);
    if (el) el.textContent = text;
  };

  const render = () => {
    const r = compute();
    setText('out-month', fmtMoney(r.month));
    setText('out-year', fmtMoney(r.year));
    setText('out-leads-now', fmtCount(r.leadsNow));
    setText('out-leads-target', fmtCount(r.leadsTarget));
    setText('out-leads', fmtCount(r.extraLeads));
    setText('out-customers', fmtCount(r.extraCustomers));

    let warn = '';
    if (state.t < state.cr) warn = `Your target is below today's rate, so there is nothing extra to count. Move the target above ${fmtPct(state.cr)}.`;
    else if (state.t === state.cr) warn = "Target equals today's rate. Move the target up to see what the difference is worth.";
    setText('calc-warn', warn);

    const arithmetic = `${fmtInt(state.v)} visitors × (${fmtPct(state.t)} − ${fmtPct(state.cr)}) = ${fmtCount(r.extraLeads)} extra leads × ${fmtPct(state.close)} close = ${fmtCount(r.extraCustomers)} customers × ${fmtMoney(state.val)} = ${fmtMoney(r.month)} a month`;
    const formula = byId('out-formula');
    if (formula) {
      formula.textContent = '';
      const label = document.createElement('strong');
      label.textContent = 'Your numbers, our arithmetic: ';
      formula.append(label, arithmetic);
    }

    document.querySelectorAll('[data-sym]').forEach((el) => {
      el.textContent = money().symbol;
    });
    document.querySelectorAll('.calc-cur').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.cur === cur));
    });

    // The "Send me this as a plan" form carries the numbers in the message.
    const summary = document.querySelector('[data-calc-summary]');
    if (summary) summary.value = `${arithmetic} (${fmtMoney(r.year)} a year). Link: ${buildUrl()}`;
  };

  const update = (except) => {
    syncInputs(except);
    scheduleUrl();
    render();
  };

  keys.forEach((k) => {
    const n = num(k);
    const r = range(k);
    if (n) {
      n.addEventListener('input', () => {
        if (n.value === '') return; // still typing; keep the last good number
        state[k] = clampNum(k, n.value);
        update(n);
      });
      // Leaving a field empty (cleared to retype, then tapped elsewhere) keeps the
      // last good number instead of dropping to zero; out-of-range typing is clamped.
      n.addEventListener('blur', () => {
        state[k] = clampNum(k, n.value, state[k]);
        update();
      });
    }
    if (r) {
      r.addEventListener('input', () => {
        state[k] = clampNum(k, r.value);
        update();
      });
    }
  });

  document.querySelectorAll('.calc-cur').forEach((button) => {
    button.addEventListener('click', () => {
      cur = button.dataset.cur === 'inr' ? 'inr' : 'usd';
      const rv = range('val');
      if (rv) rv.max = String(money().valueMax);
      update();
    });
  });

  // Enter in a number field must never reload the page.
  form.addEventListener('submit', (event) => event.preventDefault());

  const copy = byId('copy-link');
  const copyStatus = byId('copy-status');
  if (copy) {
    copy.addEventListener('click', async () => {
      writeUrl();
      const url = buildUrl();
      let done = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          done = true;
        }
      } catch {
        done = false;
      }
      if (!done) {
        // Older browsers, or no clipboard permission: select a temporary field and copy.
        const field = document.createElement('input');
        field.value = url;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.left = '-9999px';
        document.body.append(field);
        field.select();
        try {
          done = document.execCommand('copy');
        } catch {
          done = false;
        }
        field.remove();
      }
      if (copyStatus) {
        copyStatus.textContent = done
          ? 'Link copied. Anyone who opens it sees these numbers.'
          : `Copying didn't work here. The link is: ${url}`;
      }
    });
  }

  // Make sure the plan form carries the latest URL even if the timer hasn't fired.
  const plan = byId('calc-plan-form');
  if (plan) plan.addEventListener('submit', writeUrl, true);

  const rv = range('val');
  if (rv) rv.max = String(money().valueMax);
  syncInputs();
  writeUrl();
  render();
}

// ---------------------------------------------------------------------------
// Free Growth Check (growth-check.html)
// ---------------------------------------------------------------------------
// Runs on this site's own /api/growth-check (a Vercel function), never on the
// Hub. Everything that comes back is shown with textContent, never as HTML:
// titles and file names in the report come from someone else's website.
const GC_ENDPOINT = '/api/growth-check';
const GC_TIMEOUT_MS = 60000; // the function stops itself at about 45 s
const GC_STATUS_WORDS = { pass: 'Pass', warn: 'Needs work', fail: 'Fail', skipped: 'Not checked' };
const GC_RING = 2 * Math.PI * 52; // circumference of the score ring (r = 52)

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function siteLabel(href) {
  return String(href || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function growthCheckWhatsApp(report) {
  const lines = [
    'Hi Digital Dominant, please send me the fixes from my Free Growth Check.',
    `Business: ${clip(report.business || '', 80)}`,
    `Website: ${report.finalUrl || report.url}`,
    `Score: ${report.score}/100 (${report.grade})`,
  ];
  const fixes = Array.isArray(report.topFixes) ? report.topFixes : [];
  if (fixes.length) {
    lines.push('Top fixes:');
    fixes.forEach((fix, i) => lines.push(`${i + 1}. ${clip(String(fix.text || ''), 200)}`));
  }
  return waLink(lines.join('\n'));
}

function renderGrowthCheck(report) {
  const byId = (id) => document.getElementById(id);
  const score = Math.max(0, Math.min(100, Number(report.score) || 0));

  byId('gc-score').textContent = String(score);
  byId('gc-ring').dataset.grade = String(report.grade || '');
  byId('gc-ring-value').style.strokeDasharray = `${(score / 100) * GC_RING} ${GC_RING}`;
  byId('gc-grade').textContent = String(report.grade || '');
  byId('gc-grade-label').textContent = String(report.gradeLabel || '');
  byId('gc-result-business').textContent = String(report.business || siteLabel(report.finalUrl));
  byId('gc-result-site').textContent = siteLabel(report.finalUrl || report.url);
  byId('gc-speed-note').hidden = Boolean(report.speed && report.speed.available);

  const fixes = byId('gc-fixes');
  fixes.textContent = '';
  const topFixes = Array.isArray(report.topFixes) ? report.topFixes : [];
  if (topFixes.length) {
    topFixes.forEach((fix) => {
      const item = el('li');
      item.append(el('strong', '', String(fix.title || '')), el('span', '', String(fix.text || '')));
      fixes.append(item);
    });
  } else {
    const item = el('li');
    item.append(
      el('strong', '', 'Nothing urgent'),
      el('span', '', 'Your homepage covers everything we check. Book a call and we’ll look at your Google reviews and competitors next.'),
    );
    fixes.append(item);
  }

  const groups = byId('gc-groups');
  groups.textContent = '';
  (Array.isArray(report.groups) ? report.groups : []).forEach((group) => {
    const box = el('section', 'gc-group');
    box.append(el('h3', '', String(group.title || '')));
    const list = el('ul');
    (Array.isArray(group.checks) ? group.checks : []).forEach((check) => {
      const status = GC_STATUS_WORDS[check.status] ? check.status : 'skipped';
      const item = el('li', `gc-item is-${status}`);
      const icon = el('span', 'gc-icon');
      icon.setAttribute('aria-hidden', 'true');
      const body = el('div');
      body.append(el('strong', '', String(check.name || '')), el('span', '', String(check.detail || '')));
      item.append(icon, body, el('span', 'visually-hidden', ` ${GC_STATUS_WORDS[status]}`));
      list.append(item);
    });
    box.append(list);
    groups.append(box);
  });

  const notes = byId('gc-notes');
  notes.textContent = '';
  const noteList = Array.isArray(report.notes) ? report.notes : [];
  noteList.forEach((note) => notes.append(el('li', '', String(note))));
  notes.hidden = noteList.length === 0;

  byId('gc-wa').href = growthCheckWhatsApp(report);
}

function initGrowthCheck() {
  const form = document.getElementById('gc-form');
  if (!form) return;
  const byId = (id) => document.getElementById(id);
  const panels = { what: byId('gc-what'), loading: byId('gc-loading'), error: byId('gc-error'), result: byId('gc-result') };
  const show = (name) => {
    Object.entries(panels).forEach(([key, panel]) => {
      if (panel) panel.hidden = key !== name;
    });
  };
  const button = form.querySelector('[type="submit"]');
  const label = button ? button.textContent : '';
  const formError = byId('gc-form-error');
  const businessField = form.elements.namedItem('business');
  const urlField = form.elements.namedItem('url');
  let running = false;

  // A link can carry the site in: /growth-check?url=example.com&business=Example
  const params = new URLSearchParams(location.search);
  if (params.get('url')) urlField.value = params.get('url').slice(0, 2048);
  if (params.get('business')) businessField.value = params.get('business').slice(0, 80);

  const setFormError = (text, field) => {
    formError.textContent = text;
    formError.hidden = !text;
    if (field) field.focus();
  };

  const bringIntoView = (node) => {
    try {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch {
      /* ignore */
    }
  };

  const focusPanel = (node) => {
    try {
      node.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    bringIntoView(node);
  };

  const reset = () => {
    running = false;
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running) return;
    const business = businessField.value.trim();
    const url = urlField.value.trim();
    if (!business) {
      setFormError('Please enter your business name.', businessField);
      return;
    }
    if (!url) {
      setFormError('Please enter your website, like yourbusiness.com.', urlField);
      return;
    }
    setFormError('');

    running = true;
    if (button) {
      button.disabled = true;
      button.textContent = 'Checking…';
    }
    byId('gc-loading-site').textContent = siteLabel(url);
    byId('gc-elapsed').textContent = '0';
    show('loading');
    bringIntoView(panels.loading);
    const started = Date.now();
    const ticker = setInterval(() => {
      byId('gc-elapsed').textContent = String(Math.round((Date.now() - started) / 1000));
    }, 1000);

    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), GC_TIMEOUT_MS);
    let report = null;
    let failure = '';
    try {
      const response = await fetch(GC_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business, url }),
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      try {
        report = await response.json();
      } catch {
        report = null;
      }
      if (!response.ok || !report || report.ok !== true) {
        failure =
          (report && typeof report.error === 'string' && report.error) ||
          'Something went wrong on our side. Please try again in a minute.';
      }
    } catch {
      failure = controller.signal.aborted
        ? 'The check took too long this time. Please try again, or book a call and we’ll run it with you.'
        : 'We couldn’t reach our checker. Please check your connection and try again.';
    } finally {
      clearTimeout(stop);
      clearInterval(ticker);
      reset();
    }

    if (failure) {
      byId('gc-error-text').textContent = failure;
      show('error');
      focusPanel(panels.error);
      return;
    }
    renderGrowthCheck(report);
    show('result');
    focusPanel(panels.result);
  });

  const retry = byId('gc-retry');
  if (retry) {
    retry.addEventListener('click', () => {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
  }

  const again = byId('gc-again');
  if (again) {
    again.addEventListener('click', () => {
      urlField.value = '';
      show('what');
      bringIntoView(form);
      urlField.focus({ preventScroll: true });
    });
  }

  // Back/forward cache: never come back to a stuck "Checking…" button.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && running) {
      reset();
      show('what');
    }
  });
}

function init() {
  initMenu();
  initIconsAndAnimations();
  initFloatAvoid();
  initLeadForms();
  initCalculator();
  initGrowthCheck();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
