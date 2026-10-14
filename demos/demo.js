// Contractor demo sites: the 3-question quote tool, the "made for" line,
// and a live load-time readout in the demo ribbon. Nothing here sends data
// anywhere: the quote tool shows what the owner would receive, then stops.

const clean = (value, max) =>
  String(value || '')
    .replace(/[^\p{L}\p{N} &'.,\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function personalise() {
  const params = new URLSearchParams(location.search);
  const forName = clean(params.get('for'), 60);
  const city = clean(params.get('city'), 40);
  const forEl = document.querySelector('[data-for]');
  if (forEl && forName) {
    forEl.textContent = `Made for ${forName}`;
    forEl.hidden = false;
  }
  if (city) {
    document.querySelectorAll('[data-city]').forEach((el) => {
      el.textContent = city;
    });
    const towns = document.querySelector('[data-towns]');
    if (towns) towns.hidden = true;
  }
}

function speedReadout() {
  const out = document.querySelector('[data-speed]');
  if (!out || !('performance' in window)) return;
  const show = () => {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav || !nav.loadEventEnd) return;
    const seconds = nav.loadEventEnd / 1000;
    let bytes = nav.transferSize || 0;
    performance.getEntriesByType('resource').forEach((r) => {
      bytes += r.transferSize || 0;
    });
    const kb = Math.round(bytes / 1024);
    out.textContent = kb > 0 ? `Loaded in ${seconds.toFixed(1)} s · ${kb} KB` : `Loaded in ${seconds.toFixed(1)} s`;
    out.hidden = false;
  };
  if (document.readyState === 'complete') setTimeout(show, 0);
  else addEventListener('load', () => setTimeout(show, 0));
}

function quoteTool() {
  const form = document.querySelector('form.quote');
  if (!form) return;
  const steps = [...form.querySelectorAll('.q-step')];
  const bars = [...form.querySelectorAll('.progress i')];
  const back = form.querySelector('.q-back');
  const err = form.querySelector('.q-err');
  const done = form.querySelector('.q-done');
  const nav = form.querySelector('.q-nav');
  const answers = {};
  let current = 0;

  const go = (i) => {
    current = i;
    steps.forEach((s, n) => {
      s.hidden = n !== i;
    });
    bars.forEach((b, n) => b.classList.toggle('on', n <= i));
    back.hidden = i === 0;
    err.textContent = '';
    const first = steps[i].querySelector('.opt[aria-pressed="true"], .opt, input');
    if (first && form.dataset.touched) first.focus({ preventScroll: true });
  };

  form.querySelectorAll('.opts').forEach((group) => {
    const name = group.dataset.name;
    group.querySelectorAll('.opt').forEach((btn) => {
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        form.dataset.touched = '1';
        group.querySelectorAll('.opt').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        answers[name] = btn.dataset.value || btn.textContent.trim();
        setTimeout(() => go(Math.min(current + 1, steps.length - 1)), 160);
      });
    });
  });

  back.addEventListener('click', () => go(Math.max(0, current - 1)));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = form.elements.namedItem('name').value.trim();
    const phone = form.elements.namedItem('phone').value.trim();
    const zip = form.elements.namedItem('zip').value.trim();
    const digits = phone.replace(/\D/g, '');
    if (!name) { err.textContent = 'Please add your name.'; form.elements.namedItem('name').focus(); return; }
    if (digits.length < 10 || digits.length > 11) { err.textContent = 'Please check your phone number, for example 515 555 0100.'; form.elements.namedItem('phone').focus(); return; }
    if (!/^\d{5}$/.test(zip)) { err.textContent = 'Please enter a 5-digit ZIP code.'; form.elements.namedItem('zip').focus(); return; }

    const lead = `${answers.need || 'Quote request'} · ${answers.when || 'No date given'} · ${name}, ${phone}, ${zip}`;
    done.querySelector('[data-lead]').textContent = lead;
    done.querySelector('[data-biz]').textContent = form.dataset.biz || 'Your business';
    steps.forEach((s) => { s.hidden = true; });
    nav.hidden = true;
    form.querySelector('.progress').hidden = true;
    form.querySelector('.q-intro').hidden = true;
    done.hidden = false;
    done.querySelector('h3').focus();
  });

  go(0);
}

personalise();
speedReadout();
quoteTool();
