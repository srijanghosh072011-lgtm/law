/* Shared shell: nav, scroll reveals, accent retinting — plus the homepage
   modules. Page-specific blocks are guarded on the element they need, so this
   one file is safe to load everywhere. */

import { KITS, renderKit } from './kits.js';

const $ = (sel, root = document) => root.querySelector(sel);

/* ---- accent retinting ------------------------------------------------ */
/* CSSOM writes, not inline style attributes — stays clean under a strict CSP. */
export function setAccent(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const css = document.documentElement.style;
  css.setProperty('--accent', hex);
  css.setProperty('--accent-mist', `rgba(${r}, ${g}, ${b}, 0.16)`);
}

/* ---- nav ------------------------------------------------------------- */
const burger = $('#burger');
const veil = $('#veil');

if (burger && veil) {
  const setMenu = (open) => {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    veil.dataset.open = String(open);
    document.body.classList.toggle('locked', open);
  };
  burger.addEventListener('click', () => {
    setMenu(burger.getAttribute('aria-expanded') !== 'true');
  });
  veil.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenu(false);
  });
}

/* ---- scroll reveal --------------------------------------------------- */
/* IntersectionObserver, never a scroll listener. */
const targets = document.querySelectorAll('[data-reveal]');
if (targets.length) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (!entry.isIntersecting) return;
      setTimeout(() => entry.target.classList.add('seen'), i * 70);
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
  targets.forEach((t) => io.observe(t));
}

const year = $('#year');
if (year) year.textContent = String(new Date().getFullYear());

/* ---- homepage: hero stage ------------------------------------------- */
const stageArt = $('#stage-art');
if (stageArt) {
  const featured = ['madrid', 'barcelona', 'psg', 'bayern', 'arsenal']
    .map((id) => KITS.find((k) => k.id === id));
  const dots = $('#stage-dots');
  const line = $('#stage-line');
  const club = $('#stage-club');
  let at = 0;
  let timer;

  featured.forEach((kit, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-label', kit.club);
    b.addEventListener('click', () => { show(i); restart(); });
    dots.appendChild(b);
  });

  function show(i) {
    at = i;
    const kit = featured[i];
    stageArt.replaceChildren(renderKit(kit, { uid: 'stage' }));
    line.textContent = kit.line;
    club.textContent = kit.club;
    setAccent(kit.accent);
    [...dots.children].forEach((d, n) =>
      d.setAttribute('aria-current', String(n === i)));
  }

  const restart = () => {
    clearInterval(timer);
    timer = setInterval(() => show((at + 1) % featured.length), 5200);
  };

  show(0);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) restart();
}

/* ---- homepage: marquee ---------------------------------------------- */
const marquee = $('#marquee');
if (marquee) {
  const strip = () => KITS.map((k) => {
    const s = document.createElement('span');
    s.textContent = k.club;
    return s;
  });
  // Two identical runs so the -50% translate loops without a seam.
  marquee.append(...strip(), ...strip());
}

/* ---- homepage: collection grid -------------------------------------- */
const bento = $('#bento');
if (bento) {
  /* Every bento row has to total 12 columns or the last one leaves a hole.
     A wide card is 6 and pairs with two smalls; four smalls also make 12.
     Worked out from the count rather than hardcoded, because the collection
     changes and a stale index list fails silently. */
  function wideIndices(n) {
    const wide = new Set();
    let i = 0;
    while (i < n) {
      const left = n - i;
      if (left <= 2) { for (let k = i; k < n; k++) wide.add(k); i = n; }
      else if (left % 4 === 0) { i += 4; }
      else { wide.add(i); i += 3; }
    }
    return wide;
  }

  const WIDE = wideIndices(KITS.length);

  KITS.forEach((kit, i) => {
    const soon = kit.status === 'preorder';
    const card = document.createElement('a');
    card.className = 'kit' + (WIDE.has(i) ? ' kit--wide' : '') + (soon ? ' kit--soon' : '');
    card.href = `customize.html?kit=${kit.id}`;

    card.innerHTML =
      '<div class="bezel"><div class="core">' +
        '<div class="kit-art"><span class="kit-tag"></span>' +
          '<span class="kit-plate" aria-hidden="true"></span></div>' +
        '<div class="kit-foot"><div><h3></h3><p></p></div>' +
        '<span class="kit-price"></span></div>' +
      '</div></div>';

    $('.kit-tag', card).textContent = soon ? 'Preorder' : kit.line;
    // Only the wide cards render this; CSS hides it everywhere else.
    $('.kit-plate', card).textContent = kit.line;
    $('h3', card).textContent = kit.club;
    $('.kit-foot p', card).textContent = kit.note;
    $('.kit-price', card).textContent = `£${kit.price}`;
    $('.kit-art', card).appendChild(renderKit(kit, { uid: `g-${kit.id}` }));

    // Hovering a card pulls the whole page toward that club's colour.
    card.addEventListener('pointerenter', () => setAccent(kit.accent));

    bento.appendChild(card);
  });
}

/* ---- homepage: static art panels ------------------------------------ */
const printArt = $('#print-art');
if (printArt) {
  printArt.appendChild(renderKit(
    KITS.find((k) => k.id === 'barcelona'),
    { uid: 'print', name: 'Yours', number: '10' }
  ));
}

/* ---- homepage: list form -------------------------------------------- */
/* Set this to the endpoint from whichever form backend you use (Formspree,
   Web3Forms, Netlify Forms). While it is empty the form says so rather than
   silently swallowing addresses. */
const FORM_ENDPOINT = '';

const signup = $('#signup');
if (signup) {
  const note = $('#signup-note');

  signup.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(signup);

    // Honeypot: a real person never fills a field they cannot see.
    if (data.get('company')) return;

    const email = String(data.get('email') || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      note.textContent = 'That address does not look right.';
      return;
    }

    if (!FORM_ENDPOINT) {
      note.textContent = 'The list is not open yet. Check back shortly.';
      return;
    }

    const btn = $('button', signup);
    btn.disabled = true;
    note.textContent = 'Adding you…';
    try {
      const res = await fetch(FORM_ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: data
      });
      note.textContent = res.ok
        ? 'You are on the list.'
        : 'That did not go through. Try again in a moment.';
      if (res.ok) signup.reset();
    } catch {
      note.textContent = 'That did not go through. Try again in a moment.';
    } finally {
      btn.disabled = false;
    }
  });
}
