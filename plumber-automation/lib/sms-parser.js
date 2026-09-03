'use strict';

/**
 * Inbound SMS intent parsing — spec steps 4, 5, 6, 7.
 *
 * We text "Reply YES to confirm or NO to reschedule". Almost nobody replies
 * with the word YES. They reply "ya", "yep 👍", "sounds good", "cant do it",
 * "no problem", "sure thing", "actually can we move it".
 *
 * THE GOVERNING RULE: when in doubt, return UNCLEAR.
 *
 * Guessing wrong is expensive in both directions — a false YES sends a van to
 * an empty house, a false NO cancels a job the customer wanted. UNCLEAR costs
 * one human glance. So this parser only commits when the reply is genuinely
 * unambiguous to a human reader, and refuses on anything mixed.
 *
 * Returns one of: STOP | HELP | YES | NO | UNCLEAR
 */

/**
 * Carrier-mandated opt-out keywords. Checked FIRST and always win.
 *
 * IMPORTANT, AND COUNTERINTUITIVE: "CANCEL" is on this list because the
 * carriers and Twilio treat it as an opt-out keyword. A customer who replies
 * "cancel" meaning "cancel my appointment" is unsubscribed from all future
 * messages by Twilio before the text ever reaches this code. That is not a bug
 * we can fix here — see docs/COMPLIANCE.md for how to handle it.
 */
const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke'];

/** Also carrier-mandated: must return help text, must not be treated as intent. */
const HELP_WORDS = ['help', 'info'];

/**
 * Idioms that read as affirmative to any human despite containing "no".
 * Checked before bare-word matching, otherwise "no problem" scores as a NO.
 */
const AFFIRMATIVE_IDIOMS = [
  'no problem', 'no worries', 'no issues', 'not a problem',
  'no change', 'no changes', 'nothing changed',
];

/** Unambiguous confirmations. Multi-word entries are matched as phrases. */
const YES_PHRASES = [
  'sounds good', 'sounds great', 'see you then', 'see you there', 'see u then',
  'we are good', "we're good", 'all good', 'still good', 'still on', 'still works',
  'that works', 'works for me', 'that is fine', "that's fine", 'thats fine',
  'go ahead', 'good to go', 'looking forward', 'please come',
  'im home', "i'm home", 'i will be here', "i'll be here", 'ill be here',
  'confirm', 'confirmed', 'confirming', 'affirmative',
];

const YES_WORDS = [
  'yes', 'y', 'ya', 'yah', 'yeah', 'yea', 'yep', 'yup', 'yessir',
  'ok', 'okay', 'k', 'kk', 'sure', 'certainly', 'absolutely', 'definitely',
  'correct', 'right', 'perfect', 'great', 'good', 'fine', 'roger', 'aye', '1',
];

/** Unambiguous declines. */
const NO_PHRASES = [
  'cannot make', "can't make", 'cant make', 'cannot do', "can't do", 'cant do',
  'will not work', "won't work", 'wont work', 'does not work',
  "doesn't work", 'doesnt work', 'not going to work', 'not gonna work',
  'need to reschedule', 'want to reschedule', 'have to reschedule',
  'need to change', 'need to move', 'have to move', 'another time',
  'different time', 'different day', 'not available', 'not free', 'not around',
  'not home', 'wont be home', "won't be home", 'wont be here', "won't be here",
  'out of town', 'away that day', 'something came up', 'no longer need',
  'can we move', 'can we push', 'can we do', 'can we change', 'can you come',
  'move it', 'push it', 'push it back', 'shift it', 'bump it',
  'dont need', "don't need", 'do not need', 'already fixed', 'sorted it',
  'reschedule', 'rain check', 'raincheck', 'postpone',
];

const NO_WORDS = ['no', 'n', 'nope', 'nah', 'naw', 'negative', '2'];

/**
 * Explicit expressions of uncertainty. Checked BEFORE word matching, because
 * several of them contain an affirmative word: "not sure" scores as a YES on
 * the word "sure", and "I think so" on "so"-adjacent matching. A customer who
 * says they are not sure has told us plainly that they have not decided.
 */
const AMBIGUOUS_PHRASES = [
  'not sure', 'unsure', 'not certain', 'no idea', 'dont know', "don't know",
  'do not know', 'let me check', 'let me get back', 'ill let you know',
  "i'll let you know", 'i will let you know', 'i think so', 'probably',
  'possibly', 'might be', 'we will see', "we'll see", 'tbd',
];

/**
 * Contrastive conjunctions. A confirmation followed by one of these is a
 * negotiation, not a confirmation: "yes but can we move it later" is a
 * reschedule request wearing a yes. Catching the connective generalises far
 * better than trying to enumerate every way a customer might propose a change.
 */
const HEDGE_WORDS = ['but', 'however', 'although', 'though', 'except', 'unless', 'actually', 'instead'];

/** Emoji, mapped to intent. People genuinely reply with a bare thumbs-up. */
const YES_EMOJI = ['👍', '👌', '✅', '☑️', '✔️', '🙂', '😊', '💯', '🆗'];
const NO_EMOJI = ['👎', '❌', '🚫', '😞', '🙁'];

/**
 * Strip a reply down to comparable text.
 * Keeps letters, digits, apostrophes and spaces; drops punctuation and emoji
 * (emoji are detected separately, on the raw string, before this runs).
 */
function normalise(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-word match, so "no" does not fire inside "november". */
function hasWord(text, word) {
  if (word.includes(' ')) return text.includes(word);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}($|\\s)`, 'u').test(text);
}

const hasAny = (text, list) => list.some((w) => hasWord(text, w));
const hasEmoji = (raw, list) => list.some((e) => String(raw || '').includes(e));

/**
 * Parse an inbound SMS into an intent.
 *
 * @param {string} raw  the message body exactly as received
 * @returns {{intent: string, confidence: string, reason: string, normalised: string}}
 */
function parseSmsReply(raw) {
  const text = normalise(raw);
  const result = (intent, confidence, reason) => ({ intent, confidence, reason, normalised: text });

  if (!text && !hasEmoji(raw, [...YES_EMOJI, ...NO_EMOJI])) {
    return result('UNCLEAR', 'none', 'empty message');
  }

  // --- 1. Opt-out always wins, whatever else the message says -------------
  // Legally non-negotiable: "STOP texting me" must opt out even though it
  // carries no confirmation intent.
  if (hasAny(text, STOP_WORDS)) {
    return result('STOP', 'high', 'contains a carrier opt-out keyword');
  }

  // --- 2. HELP is also carrier-mandated -----------------------------------
  if (hasAny(text, HELP_WORDS) && text.split(' ').length <= 3) {
    return result('HELP', 'high', 'help request');
  }

  // --- 3. Explicit uncertainty short-circuits everything below ------------
  const ambiguous = AMBIGUOUS_PHRASES.find((p) => text.includes(p));
  if (ambiguous) {
    return result('UNCLEAR', 'none', `customer expressed uncertainty ("${ambiguous}")`);
  }

  // --- 4. Idioms that contain "no" but mean yes ---------------------------
  const idiom = AFFIRMATIVE_IDIOMS.find((p) => text.includes(p));
  // Remove the idiom before word matching, so its "no" cannot register.
  const scrubbed = idiom ? text.replace(idiom, ' ') : text;

  // --- 5. Gather signals. Phrases before bare words. ----------------------
  const yesPhrase = YES_PHRASES.find((p) => scrubbed.includes(p));
  const noPhrase = NO_PHRASES.find((p) => scrubbed.includes(p));
  const yesWord = YES_WORDS.find((w) => hasWord(scrubbed, w));
  const noWord = NO_WORDS.find((w) => hasWord(scrubbed, w));
  const yesEmoji = hasEmoji(raw, YES_EMOJI);
  const noEmoji = hasEmoji(raw, NO_EMOJI);

  const saysYes = Boolean(idiom || yesPhrase || yesWord || yesEmoji);
  const saysNo = Boolean(noPhrase || noWord || noEmoji);

  // --- 6. Mixed signals are the whole reason UNCLEAR exists ---------------
  // "yes but can we move it to Thursday" is a reschedule request wearing a
  // yes. Never collapse that into a confirmation.
  if (saysYes && saysNo) {
    return result(
      'UNCLEAR',
      'none',
      `mixed signals (yes: ${idiom || yesPhrase || yesWord || 'emoji'}, no: ${noPhrase || noWord || 'emoji'})`
    );
  }

  // A question is a conversation, not an answer — even "yes, what time?".
  if (String(raw || '').includes('?')) {
    return result('UNCLEAR', 'none', 'the customer asked a question');
  }

  // "yes, but ..." — the qualifier is the real message, so a hedged YES is
  // not a confirmation. A hedged NO ("no, Thursday instead") is still a
  // decline, and reschedule is exactly where it should go, so hedges only
  // downgrade the affirmative side.
  const hedge = HEDGE_WORDS.find((w) => hasWord(scrubbed, w));
  if (hedge && saysYes && !saysNo) {
    return result('UNCLEAR', 'none', `qualified answer (contains "${hedge}")`);
  }

  if (saysYes) {
    return result('YES', (yesPhrase || idiom) ? 'high' : 'medium',
      `affirmative: ${idiom || yesPhrase || yesWord || 'emoji'}`);
  }

  if (saysNo) {
    return result('NO', noPhrase ? 'high' : 'medium',
      `decline: ${noPhrase || noWord || 'emoji'}`);
  }

  return result('UNCLEAR', 'none', 'no recognisable yes or no');
}

module.exports = {
  parseSmsReply, normalise,
  STOP_WORDS, HELP_WORDS, YES_WORDS, NO_WORDS, HEDGE_WORDS,
  AFFIRMATIVE_IDIOMS, AMBIGUOUS_PHRASES,
};
