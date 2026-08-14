/* The print room. Live preview, live moderation, local bag. */

import { KITS, kitById, renderKit } from './kits.js';
import { checkPersonalisation } from './moderation.js';
import { setAccent } from './app.js';

const $ = (sel) => document.querySelector(sel);

const PRINT_FEE = 18;
const SIZES = [
  ['XS', 47], ['S', 50], ['M', 53], ['L', 56],
  ['XL', 59], ['2XL', 62], ['3XL', 65]
];

const art = $('#preview-art');
if (art) {
  const kitSel = $('#kit');
  const nameIn = $('#pname');
  const numIn = $('#pnum');
  const nameField = $('#name-field');
  const verdict = $('#verdict');
  const verdictText = $('#verdict-text');
  const addBtn = $('#add');
  const addNote = $('#add-note');
  const sizeHint = $('#size-hint');

  // ?kit=barcelona deep-links from a collection card.
  const wanted = new URLSearchParams(location.search).get('kit');
  let kit = kitById(wanted) || KITS[0];
  let size = 'M';

  KITS.forEach((k) => {
    const o = document.createElement('option');
    o.value = k.id;
    o.textContent = `${k.club} — ${k.line}`;
    kitSel.appendChild(o);
  });
  kitSel.value = kit.id;

  const sizeBox = $('#sizes');
  SIZES.forEach(([label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(label === size));
    b.addEventListener('click', () => {
      size = label;
      [...sizeBox.children].forEach((c) =>
        c.setAttribute('aria-pressed', String(c === b)));
      paintHint();
      paintTally();
    });
    sizeBox.appendChild(b);
  });

  function paintHint() {
    const cm = SIZES.find(([l]) => l === size)[1];
    sizeHint.textContent = `${size} — ${cm}cm chest, measured flat across.`;
  }

  /* One evaluation pass drives the preview, the message and the button. */
  function evaluate() {
    const name = nameIn.value.trim();
    const num = numIn.value.trim();

    // Nothing entered is a valid order — a blank shirt.
    if (!name && !num) {
      return { ok: true, blank: true };
    }
    if (!name && num) {
      return { ok: false, field: 'name', reason: 'A number needs a name above it.' };
    }
    return checkPersonalisation(name, num, kit.id);
  }

  function paint() {
    const result = evaluate();
    const name = nameIn.value.trim();
    const num = numIn.value.trim();

    // Only ever draw wording that has cleared the check.
    const show = result.ok && !result.blank;
    art.replaceChildren(renderKit(kit, {
      uid: 'preview',
      name: show ? name : '',
      number: show ? num : ''
    }));

    $('#preview-line').textContent = kit.line;
    $('#preview-club').textContent = kit.club;
    $('#preview-spec').textContent = show
      ? `${name.toUpperCase()}${num ? ' · ' + num : ''} · ${size}`
      : `No print · ${size}`;

    if (result.blank) {
      verdict.dataset.tone = 'idle';
      verdictText.textContent = 'Twelve characters and a number from 1 to 99. Or leave both empty.';
      nameField.dataset.state = '';
    } else if (result.ok) {
      verdict.dataset.tone = 'good';
      verdictText.textContent = `${name.toUpperCase()} is clear to print.`;
      nameField.dataset.state = 'good';
    } else {
      verdict.dataset.tone = 'bad';
      verdictText.textContent = result.reason;
      nameField.dataset.state = 'bad';
    }

    addBtn.disabled = !result.ok;
    paintTally();
  }

  function paintTally() {
    const r = evaluate();
    const printed = r.ok && !r.blank;
    $('#total').textContent = `£${kit.price + (printed ? PRINT_FEE : 0)}`;
  }

  kitSel.addEventListener('change', () => {
    kit = kitById(kitSel.value);
    setAccent(kit.accent);
    addNote.textContent = '';
    paint();
  });

  nameIn.addEventListener('input', () => { addNote.textContent = ''; paint(); });
  numIn.addEventListener('input', () => {
    numIn.value = numIn.value.replace(/\D/g, '').slice(0, 2);
    addNote.textContent = '';
    paint();
  });

  /* ---- bag ----------------------------------------------------------- */
  /* ponytail: localStorage is the whole cart. Move it server-side when
     checkout exists and a bag has to survive a device change. */
  const BAG = 'onze.bag';
  const readBag = () => {
    try { return JSON.parse(localStorage.getItem(BAG)) || []; }
    catch { return []; }
  };

  function paintBag() {
    const n = readBag().length;
    const pip = $('#bag-pip');
    if (pip) pip.textContent = String(n);
    const sr = $('#bag-sr');
    if (sr) sr.textContent = `${n} item${n === 1 ? '' : 's'} in bag`;
  }

  $('#print-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const result = evaluate();
    if (!result.ok) { paint(); return; }

    const name = nameIn.value.trim();
    const num = numIn.value.trim();
    const bag = readBag();
    bag.push({
      kit: kit.id, club: kit.club, size,
      name: result.blank ? '' : name.toUpperCase(),
      number: result.blank ? '' : num,
      price: kit.price + (result.blank ? 0 : PRINT_FEE)
    });
    localStorage.setItem(BAG, JSON.stringify(bag));
    paintBag();

    addNote.textContent = result.blank
      ? `${kit.club}, size ${size}, added.`
      : `${kit.club}, size ${size}, ${name.toUpperCase()}${num ? ' ' + num : ''} — added.`;
  });

  setAccent(kit.accent);
  paintHint();
  paintBag();
  paint();
}
