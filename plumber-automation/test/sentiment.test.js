'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyFeedback, fromRating, fromKeywords,
  modelPrompt, parseModelSentiment, discountCode,
} = require('../lib/sentiment.js');

// --- the rule that protects the client's reputation -----------------------

test('a public review is NEVER requested below 4 stars', () => {
  // Asking a 2-star customer to review you on Google is asking them to
  // publish the complaint. This is the most damaging thing a badly built
  // feedback automation does.
  for (const rating of [1, 2, 3]) {
    const r = classifyFeedback({ rating });
    assert.equal(r.actions.reviewRequest, false, `${rating} stars must not get a review link`);
  }
});

test('4 and 5 stars do get the review request', () => {
  for (const rating of [4, 5]) {
    assert.equal(classifyFeedback({ rating }).actions.reviewRequest, true);
  }
});

test('a 3-star is neutral: no review ask, no urgent callback', () => {
  // A 3-star public review drags the average down and reads as lukewarm.
  const r = classifyFeedback({ rating: 3 });
  assert.equal(r.sentiment, 'neutral');
  assert.equal(r.actions.reviewRequest, false);
  assert.equal(r.actions.ownerCallback, false);
  assert.equal(r.actions.quietFollowUp, true);
});

// --- routing --------------------------------------------------------------

test('1 and 2 stars create a callback task for the owner (spec step 13)', () => {
  for (const rating of [1, 2]) {
    const r = classifyFeedback({ rating });
    assert.equal(r.sentiment, 'negative');
    assert.equal(r.actions.ownerCallback, true);
    assert.equal(r.actions.recoveryEmail, true);
    assert.equal(r.actions.discount, false, 'a discount is not an apology');
  }
});

test('a positive rating gets thank-you and discount (spec step 14)', () => {
  const r = classifyFeedback({ rating: 5 });
  assert.equal(r.actions.thankYou, true);
  assert.equal(r.actions.discount, true);
});

test('everyone enters nurture regardless of sentiment (spec step 15)', () => {
  for (const feedback of [{ rating: 1 }, { rating: 3 }, { rating: 5 }, {}]) {
    assert.equal(classifyFeedback(feedback).actions.nurture, true);
  }
});

// --- free text ------------------------------------------------------------

test('clearly positive free text is recognised without a model call', () => {
  const r = classifyFeedback({ text: 'Absolutely fantastic work, highly recommend' });
  assert.equal(r.sentiment, 'positive');
  assert.equal(r.needsModel, false);
});

test('clearly negative free text is recognised without a model call', () => {
  const r = classifyFeedback({ text: 'He was rude and it is still leaking' });
  assert.equal(r.sentiment, 'negative');
  assert.equal(r.actions.ownerCallback, true);
});

test('mixed feedback is treated as negative — the complaint takes priority', () => {
  // "Great work but he was two hours late" is not a review request candidate.
  const r = classifyFeedback({ text: 'Great job but he was two hours late' });
  assert.equal(r.sentiment, 'negative');
  assert.equal(r.actions.reviewRequest, false);
});

test('a rating contradicted by the comment resolves cautiously', () => {
  // Someone clicks 5 stars out of politeness and then says it is still
  // leaking. The comment is the truth; a review request here would be awful.
  const r = classifyFeedback({ rating: 5, text: 'still leaking unfortunately' });
  assert.equal(r.sentiment, 'negative');
  assert.equal(r.actions.reviewRequest, false);
  assert.equal(r.actions.ownerCallback, true);
  assert.equal(r.confidence, 'low');
});

test('genuinely ambiguous text escalates to the model rather than guessing', () => {
  const r = classifyFeedback({ text: 'it was fine i guess' });
  assert.equal(r.sentiment, 'unknown');
  assert.equal(r.needsModel, true);
  assert.equal(r.actions.reviewRequest, false, 'never ask for a review on an unknown');
});

test('no feedback at all does not trigger a model call', () => {
  const r = classifyFeedback({});
  assert.equal(r.needsModel, false);
  assert.equal(r.actions.nurture, true);
});

// --- helpers --------------------------------------------------------------

test('fromRating handles non-numeric input', () => {
  assert.equal(fromRating(undefined), null);
  assert.equal(fromRating('not a number'), null);
  assert.equal(fromRating('5').sentiment, 'positive', 'form values arrive as strings');
});

test('fromKeywords returns null on genuinely neutral text', () => {
  assert.equal(fromKeywords('the appointment was on tuesday'), null);
  assert.equal(fromKeywords(''), null);
  assert.equal(fromKeywords(null), null);
});

test('the model reply is parsed defensively', () => {
  assert.equal(parseModelSentiment('positive'), 'positive');
  assert.equal(parseModelSentiment('  Negative.  '), 'negative');
  assert.equal(parseModelSentiment('POSITIVE'), 'positive');
  // Anything unexpected lands on neutral: no review ask, no urgent callback.
  assert.equal(parseModelSentiment('I think it was probably fine'), 'neutral');
  assert.equal(parseModelSentiment(''), 'neutral');
  assert.equal(parseModelSentiment(null), 'neutral');
});

test('the model prompt constrains the answer to one word', () => {
  const prompt = modelPrompt('it was ok');
  assert.match(prompt, /one word only/);
  assert.match(prompt, /it was ok/);
});

test('a quote in the feedback cannot break out of the prompt', () => {
  const prompt = modelPrompt('he said "it is fine" but it leaked');
  assert.ok(!prompt.includes('"it is fine"'), 'double quotes should be neutralised');
});

test('discount codes are stable and readable over the phone', () => {
  const code = discountCode('Dana Reyes', 'a1b2c3d4-0000-0000-0000-00000000f9e2');
  assert.equal(code, discountCode('Dana Reyes', 'a1b2c3d4-0000-0000-0000-00000000f9e2'));
  assert.match(code, /^THANKS[A-Z0-9]+$/);
  assert.ok(code.length <= 16);
});

test('discount code generation survives missing input', () => {
  assert.doesNotThrow(() => discountCode(null, null));
  assert.match(discountCode(null, null), /^THANKS/);
});
