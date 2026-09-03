'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSmsReply, normalise } = require('../lib/sms-parser.js');

const intent = (s) => parseSmsReply(s).intent;

// --- opt-out and help: legally mandatory, must always win ------------------

test('every carrier opt-out keyword is detected', () => {
  for (const word of ['STOP', 'stop', 'Stop', 'UNSUBSCRIBE', 'QUIT', 'END', 'CANCEL', 'STOPALL', 'revoke']) {
    assert.equal(intent(word), 'STOP', `"${word}" must opt out`);
  }
});

test('opt-out wins even when the message also contains a confirmation', () => {
  // "yes but stop texting me" is an opt-out first and foremost. Getting this
  // backwards is a TCPA violation, not a UX annoyance.
  assert.equal(intent('yes but stop texting me'), 'STOP');
  assert.equal(intent('ok stop'), 'STOP');
});

test('HELP is recognised and not treated as a yes or no', () => {
  assert.equal(intent('HELP'), 'HELP');
  assert.equal(intent('info'), 'HELP');
});

test('a long message merely containing "help" is not a HELP request', () => {
  // "help me understand" is conversation, not the carrier HELP keyword.
  assert.notEqual(intent('I need help understanding what you will be doing'), 'HELP');
});

// --- affirmatives ---------------------------------------------------------

test('the many ways people say yes are all understood', () => {
  for (const reply of [
    'YES', 'yes', 'Yes.', 'y', 'ya', 'yah', 'yeah', 'yea', 'yep', 'yup',
    'ok', 'OK!', 'okay', 'k', 'sure', 'sure thing', 'absolutely', 'definitely',
    'confirmed', 'confirming', 'perfect', 'great', 'sounds good', 'sounds great',
    'see you then', 'that works', 'works for me', 'all good', 'still on',
    'good to go', "we're good", "I'll be here", '1',
  ]) {
    assert.equal(intent(reply), 'YES', `"${reply}" should confirm`);
  }
});

test('affirmative idioms containing "no" are not read as declines', () => {
  // THE classic false negative. "No problem" is a yes to every human alive.
  for (const reply of ['no problem', 'No problem!', 'no worries', 'not a problem', 'no issues']) {
    assert.equal(intent(reply), 'YES', `"${reply}" should confirm`);
  }
});

test('a bare thumbs-up confirms', () => {
  assert.equal(intent('\u{1F44D}'), 'YES');
  assert.equal(intent('yep \u{1F44D}'), 'YES');
  assert.equal(intent('✅'), 'YES');
});

// --- declines -------------------------------------------------------------

test('the many ways people say no are all understood', () => {
  for (const reply of [
    'NO', 'no', 'No.', 'nope', 'nah', 'negative', '2',
    "can't make it", 'cant make it', 'cannot do that day',
    "won't work", 'that doesnt work', 'not going to work',
    'need to reschedule', 'I need to reschedule', 'have to move it',
    'not available', 'not home', 'out of town', 'something came up',
    'already fixed it', 'no longer need it', 'postpone', 'rain check',
  ]) {
    assert.equal(intent(reply), 'NO', `"${reply}" should decline`);
  }
});

test('a bare thumbs-down declines', () => {
  assert.equal(intent('\u{1F44E}'), 'NO');
});

test('a proposed alternative time is a decline, not a confirmation', () => {
  for (const reply of ['can we move it to Friday', 'can we do Thursday instead', 'push it back a week']) {
    assert.equal(intent(reply), 'NO', `"${reply}" should route to reschedule`);
  }
});

// --- UNCLEAR: the safety net ---------------------------------------------

test('mixed signals return UNCLEAR rather than a guess', () => {
  // A false YES sends a van to an empty house. A false NO cancels a job the
  // customer wanted. UNCLEAR costs one human glance — always the cheaper error.
  for (const reply of [
    'yes but can we move it later',
    'ok but I might be late',
    'not sure yet',
    'let me check and get back to you',
  ]) {
    assert.equal(intent(reply), 'UNCLEAR', `"${reply}" should not be auto-resolved`);
  }
});

test('a hedged decline still routes to reschedule', () => {
  // Only the affirmative side is downgraded by a hedge: "no, Thursday
  // instead" is a decline, and reschedule is exactly where it belongs.
  assert.equal(intent('actually no'), 'NO');
  assert.equal(intent('can we do Thursday instead'), 'NO');
});

test('a question is never treated as an answer', () => {
  for (const reply of ['what time?', 'yes, what time?', 'how much will it cost?', 'is it still Tuesday?']) {
    assert.equal(intent(reply), 'UNCLEAR', `"${reply}" needs a human`);
  }
});

test('unrecognisable and empty replies are UNCLEAR, not defaults', () => {
  for (const reply of ['', '   ', null, undefined, 'asdf', 'maybe', 'not sure', 'hmm', '\u{1F914}']) {
    assert.equal(intent(reply), 'UNCLEAR', `${JSON.stringify(reply)} should be UNCLEAR`);
  }
});

test('"no" inside a longer word does not trigger a decline', () => {
  // Whole-word matching: "november", "nothing", "notice", "know".
  assert.notEqual(intent('November works for me'), 'NO');
  assert.equal(intent('I know, see you then'), 'YES');
});

// --- shape ----------------------------------------------------------------

test('every result explains itself for the audit trail', () => {
  const r = parseSmsReply('cant make it');
  assert.equal(r.intent, 'NO');
  assert.equal(r.confidence, 'high');
  assert.match(r.reason, /decline/);
  assert.equal(r.normalised, 'cant make it');
});

test('parsing never throws, whatever arrives', () => {
  // This runs on a public webhook — the input is whatever the carrier sends.
  const zwjFamily = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  for (const junk of [null, undefined, 123, {}, [], ' ', 'x'.repeat(5000), zwjFamily]) {
    assert.doesNotThrow(() => parseSmsReply(junk));
  }
});

test('normalise strips punctuation and collapses whitespace', () => {
  assert.equal(normalise('  YES!!!  Please.  '), 'yes please');
  assert.equal(normalise("that's fine"), "that's fine");
});
