'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideRoute } = require('../lib/reply-routing.js');

const route = (opts) => decideRoute(opts).route;

test('a confirmation routes to the confirmed path', () => {
  assert.equal(route({ intent: 'YES', hasJob: true, declineCount: 0 }), 'YES');
});

test('the first decline offers a reschedule (spec step 5)', () => {
  assert.equal(route({ intent: 'NO', hasJob: true, declineCount: 0 }), 'NO_FIRST');
});

test('a second decline stops the chase and moves to nurture (spec step 6)', () => {
  assert.equal(route({ intent: 'NO', hasJob: true, declineCount: 1 }), 'NO_AGAIN');
  assert.equal(route({ intent: 'NO', hasJob: true, declineCount: 5 }), 'NO_AGAIN');
});

test('opt-out is honoured even with no matching appointment', () => {
  // Someone can STOP months after their last job. Requiring an open job here
  // would silently ignore a legally binding opt-out.
  assert.equal(route({ intent: 'STOP', hasJob: false }), 'STOP');
  assert.equal(route({ intent: 'STOP', hasJob: true, declineCount: 3 }), 'STOP');
});

test('HELP is answered regardless of appointment state', () => {
  assert.equal(route({ intent: 'HELP', hasJob: false }), 'HELP');
  assert.equal(route({ intent: 'HELP', hasJob: true }), 'HELP');
});

test('a yes or no with no matching job goes to a human, not nowhere', () => {
  // Dropping these silently is how a customer's "no" gets ignored and a van
  // turns up anyway.
  assert.equal(route({ intent: 'YES', hasJob: false }), 'NO_JOB');
  assert.equal(route({ intent: 'NO', hasJob: false }), 'NO_JOB');
});

test('an unclear reply is escalated, never assumed', () => {
  assert.equal(route({ intent: 'UNCLEAR', hasJob: true, declineCount: 0 }), 'UNCLEAR');
});

test('an unknown intent falls through to escalation rather than a default action', () => {
  // Defensive: if the parser ever grows a new intent, the safe landing spot
  // is a human, not a silent confirmation.
  assert.equal(route({ intent: 'SOMETHING_NEW', hasJob: true }), 'UNCLEAR');
});

test('a missing declineCount is treated as zero', () => {
  assert.equal(route({ intent: 'NO', hasJob: true }), 'NO_FIRST');
});

test('every decision explains itself', () => {
  const d = decideRoute({ intent: 'NO', hasJob: true, declineCount: 1 });
  assert.equal(d.route, 'NO_AGAIN');
  assert.match(d.why, /stop chasing/);
});
