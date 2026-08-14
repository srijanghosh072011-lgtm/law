/* Personalisation moderation.
   Four gates, checked in order: format -> blocked terms -> rival club name ->
   player/club mismatch. First failure wins so the shopper gets one clear reason.

   The SEVERE and HATE lists are ROT13-encoded on purpose. They are decoded at
   load. This keeps a wall of slurs out of the source tree, out of code review,
   and out of anything that greps the repo. It is obfuscation for the reader,
   not security — the filter runs client-side and is a first pass only.

   ponytail: a hand-kept list is the right size for a ten-kit shop. Swap the
   term lists for a hosted moderation API when order volume makes upkeep hurt. */

import { KITS } from './kits.js';

const rot13 = (s) => s.replace(/[a-z]/g, (c) =>
  String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

const SEVERE = ['avttre', 'avttn', 'snttbg', 'sntbg', 'genaal', 'puvax', 'fcvp', 'jrgonpx', 'xvxr', 'tbbx', 'pbba', 'cnxv', 'enturnq', 'gbjryurnq', 'ornare', 'qnexvr', 'arteb', 'fnaqavttre', 'wvtnobb', 'furznyr', 'ergneq', 'zbatbybvq', 'tlcb', 'cvxrl'].map(rot13);

const HATE = ['uvgyre', 'nqbysuvgyre', 'urvyuvgyre', 'anmv', 'fvrturyy', 'fvrturvy', 'xxx', 'juvgrcbjre', 'juvgrcevqr', 'tnfpunzore', 'ubybpnhfg', 'trabpvqr', 'vfvf', 'nydnrqn', 'gnyvona', 'ylapu', 'fynirel', 'ncnegurvq', 'rguavppyrnafvat', 'qrngugbnyy', 'xvyynyy', 'tnfgurz', 'fraqgurzonpx', 'abjuvgrf', 'aboynpxf', 'abwrjf', 'abzhfyvzf'].map(rot13);

/* Matched on word boundaries rather than substrings, so "Scunthorpe",
   "Assange" and "Cockburn" are not casualties. */
const PROFANITY = ['fuck', 'fucker', 'fucking', 'shit', 'shite', 'bitch', 'cunt', 'wanker', 'bastard', 'twat', 'prick', 'dick', 'cock', 'pussy', 'arsehole', 'asshole', 'bollocks', 'slut', 'whore', 'rape', 'rapist', 'porn', 'sex', 'nonce', 'paedo', 'pedo', 'meth', 'cocaine', 'heroin', 'kys', 'suicide'];

/* Numbers with a meaning nobody wants printed. Squad numbers are two digits,
   so the longer codes never reach here — the format gate rejects them first. */
const BLOCKED_NUMBERS = ['88', '18', '14'];

/* Where a name legitimately belongs. Chosen kit outside this list is refused.
   Players with two real homes on this shop carry both. */
const LEGENDS = {
  ronaldo: ['madrid', 'united'],
  cristiano: ['madrid', 'united'],
  cr7: ['madrid', 'united'],
  messi: ['barcelona', 'psg'],
  benzema: ['madrid'],
  zidane: ['madrid'],
  ramos: ['madrid', 'psg'],
  raul: ['madrid'],
  modric: ['madrid'],
  kroos: ['madrid'],
  bellingham: ['madrid'],
  vinicius: ['madrid'],
  casillas: ['madrid'],
  figo: ['madrid', 'barcelona'],
  xavi: ['barcelona'],
  iniesta: ['barcelona'],
  puyol: ['barcelona'],
  pique: ['barcelona'],
  busquets: ['barcelona'],
  ronaldinho: ['barcelona', 'psg'],
  cruyff: ['barcelona'],
  yamal: ['barcelona'],
  neymar: ['barcelona', 'psg'],
  mbappe: ['psg', 'madrid'],
  ibrahimovic: ['psg', 'united', 'barcelona'],
  cavani: ['psg', 'united'],
  verratti: ['psg'],
  muller: ['bayern'],
  neuer: ['bayern'],
  kahn: ['bayern'],
  beckenbauer: ['bayern'],
  robben: ['bayern'],
  ribery: ['bayern'],
  kimmich: ['bayern'],
  lewandowski: ['bayern', 'barcelona'],
  henry: ['arsenal', 'barcelona'],
  bergkamp: ['arsenal'],
  vieira: ['arsenal'],
  saka: ['arsenal'],
  odegaard: ['arsenal', 'madrid'],
  wenger: ['arsenal'],
  gerrard: ['liverpool'],
  salah: ['liverpool'],
  dalglish: ['liverpool'],
  klopp: ['liverpool'],
  vandijk: ['liverpool'],
  alisson: ['liverpool'],
  rooney: ['united', 'everton'],
  beckham: ['united', 'madrid', 'psg'],
  cantona: ['united'],
  scholes: ['united'],
  giggs: ['united'],
  keane: ['united'],
  ferguson: ['united'],
  aguero: ['city', 'barcelona'],
  debruyne: ['city'],
  haaland: ['city'],
  silva: ['city', 'chelsea'],
  guardiola: ['city', 'barcelona', 'bayern'],
  lampard: ['chelsea'],
  terry: ['chelsea'],
  drogba: ['chelsea'],
  hazard: ['chelsea', 'madrid'],
  palmer: ['chelsea'],
  kane: ['spurs', 'bayern'],
  son: ['spurs'],
  bale: ['spurs', 'madrid'],
  hoddle: ['spurs']
};

/* Leetspeak, spacing and diacritics all collapse to plain lowercase letters
   before any term is compared. Runs of 3+ drop to 2, which keeps real doubled
   letters ("Bell") intact. */
function normalise(input) {
  return input
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't')
    .replace(/8/g, 'b').replace(/9/g, 'g').replace(/2/g, 'z')
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1');
}

/* Padding a term with repeats ("niiiggger", "cccooon") survives the collapse
   above, so each blocked term is matched by a regex that lets every one of its
   characters repeat: "coon" -> /c+o+o+n+/. Squeezing the input instead would
   reduce "kkk" to "k" and flag every name containing one. Terms are plain a-z,
   so nothing needs escaping. Built once at load. */
const repeatTolerant = (list) =>
  list.map((t) => new RegExp(t.split('').map((c) => c + '+').join('')));

const hits = (patterns, flat) => patterns.some((re) => re.test(flat));

const SEVERE_RE = repeatTolerant(SEVERE);
const HATE_RE = repeatTolerant(HATE);

/* "a Arsenal" reads as a typo and undercuts the whole message. */
const article = (word) => (/^[AEIOU]/i.test(word) ? 'an' : 'a');

const CLUB_NAMES = KITS.map((k) => ({
  id: k.id,
  keys: [normalise(k.club), normalise(k.line), normalise(k.city), k.id]
}));

/**
 * @param {string} name  raw name field
 * @param {string} number  raw number field
 * @param {string} kitId  id of the selected colourway
 * @returns {{ok: boolean, reason?: string, field?: 'name'|'number'}}
 */
export function checkPersonalisation(name, number, kitId) {
  const raw = (name || '').trim();
  const num = (number || '').trim();

  if (!raw) return { ok: false, field: 'name', reason: 'Add a name to print.' };
  if (raw.length > 12) {
    return { ok: false, field: 'name', reason: 'Twelve characters is the print limit.' };
  }
  // Curly apostrophes arrive from phone keyboards and pasted text.
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'\u2019 .-]+$/.test(raw)) {
    return { ok: false, field: 'name', reason: 'Letters, spaces, hyphens and apostrophes only.' };
  }

  const flat = normalise(raw);
  if (flat.length < 2) {
    return { ok: false, field: 'name', reason: 'That is too short to print cleanly.' };
  }
  if (/^(.)\1+$/.test(flat)) {
    return { ok: false, field: 'name', reason: 'That is not a name.' };
  }

  if (hits(SEVERE_RE, flat)) {
    return { ok: false, field: 'name', reason: 'We will not print that. Choose something else.' };
  }
  if (hits(HATE_RE, flat)) {
    return { ok: false, field: 'name', reason: 'We will not print that. Choose something else.' };
  }

  const words = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean).map(normalise);
  if (words.some((w) => PROFANITY.includes(w)) || PROFANITY.includes(flat)) {
    return { ok: false, field: 'name', reason: 'Keep it printable — that one will not pass.' };
  }

  if (num) {
    if (!/^\d{1,2}$/.test(num) || Number(num) < 1) {
      return { ok: false, field: 'number', reason: 'Squad numbers run 1 to 99.' };
    }
    if (BLOCKED_NUMBERS.includes(num)) {
      return { ok: false, field: 'number', reason: 'That number is not available. Pick another.' };
    }
  }

  const rival = CLUB_NAMES.find((c) => c.id !== kitId && c.keys.includes(flat));
  if (rival) {
    const club = KITS.find((k) => k.id === rival.id).club;
    const on = KITS.find((k) => k.id === kitId).club;
    return {
      ok: false, field: 'name',
      reason: `${club} does not go on ${article(on)} ${on} shirt. We are not printing that one.`
    };
  }

  const homes = LEGENDS[flat];
  if (homes && !homes.includes(kitId)) {
    const on = KITS.find((k) => k.id === kitId).club;
    const where = homes
      .map((id) => (KITS.find((k) => k.id === id) || {}).club)
      .filter(Boolean);
    const wore = where.length ? ` Try ${where.join(' or ')}.` : '';
    return {
      ok: false, field: 'name',
      reason: `${raw.toUpperCase()} on ${article(on)} ${on} shirt is a no from us.${wore}`
    };
  }

  return { ok: true };
}
