// Shared behaviour for every page: mobile menu, scroll animations, icons and
// the lead forms (contact + book) that post to DD Hub.
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
  // Optional fields the Hub has no column for (e.g. business name) ride along in the message.
  const extras = [...form.querySelectorAll('[data-lead-extra]')]
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

function findProblem(form, lead) {
  const digits = lead.phone.replace(/\D/g, '').length;
  const phoneField = form.elements.namedItem('phone');
  if (phoneField && (!lead.phone || !PHONE_RE.test(lead.phone) || digits < 7 || digits > 15)) {
    return { field: phoneField, message: 'Please check your phone number. Use digits only, for example 98765 43210.' };
  }
  const emailField = form.elements.namedItem('email');
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

function init() {
  initMenu();
  initIconsAndAnimations();
  initLeadForms();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
