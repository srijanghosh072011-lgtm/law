/* ponytail: one runnable check for the only non-trivial logic in the site.
   No framework, no fixtures. Run it with:  node test/moderation.test.mjs
   Exits non-zero on the first failure, so it drops straight into CI. */

import assert from 'node:assert/strict';
import { checkPersonalisation } from '../assets/js/moderation.js';

const BLOCK = false;
const ALLOW = true;

/* [kit, name, number, expected, what it is guarding] */
const cases = [
  // The rule the shop is actually known for.
  ['barcelona', 'Ronaldo', '7', BLOCK, 'legend on a rival colourway'],
  ['madrid', 'Ronaldo', '7', ALLOW, 'legend on a club he played for'],
  ['united', 'Ronaldo', '7', ALLOW, 'legend on his other club'],
  ['madrid', 'Messi', '10', BLOCK, 'legend on a rival colourway'],
  ['barcelona', 'Messi', '10', ALLOW, 'legend at home'],
  ['arsenal', 'Kane', '9', BLOCK, 'legend on a rival colourway'],
  ['bayern', 'Kane', '9', ALLOW, 'same legend, club he did play for'],

  // Rival club names, derived from the kit list rather than a second list.
  ['madrid', 'Barcelona', '9', BLOCK, 'rival club name'],
  ['united', 'Anfield', '9', BLOCK, 'rival colourway name'],
  ['barcelona', 'Barcelona', '9', ALLOW, 'own club name is fine'],
  ['arsenal', 'Tottenham', '9', BLOCK, 'club we no longer stock'],
  ['arsenal', 'Spurs', '9', BLOCK, 'nickname of a club we no longer stock'],
  ['liverpool', 'Everton', '9', BLOCK, 'club never in the catalogue'],
  ['united', 'Juventus', '9', BLOCK, 'foreign club'],
  ['liverpool', 'Son', '7', BLOCK, 'legend of a club we no longer stock'],

  // Slurs and hate terms, including evasion attempts.
  ['liverpool', 'n i g g e r', '9', BLOCK, 'spacing evasion'],
  ['liverpool', 'niiiggger', '9', BLOCK, 'repeat-padding evasion'],
  ['liverpool', 'cccooon', '9', BLOCK, 'repeat-padding, short term'],
  ['liverpool', 'nÌgger', '9', BLOCK, 'diacritic evasion'],
  ['liverpool', 'hhhitler', '9', BLOCK, 'padded hate term'],
  ['liverpool', 'f u c k', '9', BLOCK, 'spaced profanity'],

  // Names that merely look suspicious and must survive.
  ['liverpool', 'Scunthorpe', '9', ALLOW, 'the classic false positive'],
  ['liverpool', 'Dickinson', '9', ALLOW, 'substring of a blocked word'],
  ['liverpool', 'Kirk', '9', ALLOW, 'single k, not kkk'],
  ['liverpool', 'Bell', '9', ALLOW, 'genuine doubled letter'],
  ['liverpool', 'Aaron', '9', ALLOW, 'genuine doubled letter'],
  ['liverpool', "O'Brien", '4', ALLOW, 'straight apostrophe'],
  ['liverpool', 'O’Brien', '4', ALLOW, 'curly apostrophe from a phone'],
  ['liverpool', 'Müller', '9', BLOCK, 'legend on a rival colourway'],
  ['bayern', 'Müller', '9', ALLOW, 'accented name at home'],

  // Format and number rules.
  ['liverpool', 'Smith', '88', BLOCK, 'coded number'],
  ['liverpool', 'Smith', '0', BLOCK, 'squad numbers start at 1'],
  ['liverpool', 'Smith', '9', ALLOW, 'ordinary order'],
  ['liverpool', 'Bartholomew123', '9', BLOCK, 'digits are not letters'],
  ['liverpool', 'Constantinople', '9', BLOCK, 'over twelve characters'],
  ['liverpool', 'aaaaaa', '9', BLOCK, 'not a name'],
  ['liverpool', 'X', '9', BLOCK, 'too short to print'],
  ['liverpool', '', '9', BLOCK, 'a number needs a name']
];

let failed = 0;
for (const [kit, name, num, expected, what] of cases) {
  const got = checkPersonalisation(name, num, kit).ok;
  if (got !== expected) {
    failed++;
    console.error(
      `FAIL  ${kit} / "${name}" / ${num || '-'}  (${what})\n` +
      `      expected ${expected ? 'ALLOW' : 'BLOCK'}, got ${got ? 'ALLOW' : 'BLOCK'}`
    );
  }
}

assert.equal(failed, 0, `${failed} of ${cases.length} moderation cases failed`);
console.log(`moderation: ${cases.length} cases passed`);
