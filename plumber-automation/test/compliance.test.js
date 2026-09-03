'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  guardOutboundSms, inQuietHours, nextSendableTime, countSegments, isTransactional,
} = require('../lib/compliance.js');

const ENV = {
  BUSINESS_TIMEZONE: 'America/Chicago',
  QUIET_HOURS_START: '21',
  QUIET_HOURS_END: '8',
  BUSINESS_NAME: 'RRP',
  BUSINESS_PHONE: '+15125550100',
};
const QUIET = { start: 21, end: 8 };
const TZ = 'America/Chicago';

// Chicago is UTC-6 in January.
const NINE_AM = new Date('2026-01-15T15:00:00Z');
const NINE_PM = new Date('2026-01-16T03:30:00Z');
const SIX_AM  = new Date('2026-01-16T12:00:00Z');

// --- opt-out --------------------------------------------------------------

test('an opted-out recipient is never texted, whatever the message', () => {
  // No template is important enough to override a STOP. This is the single
  // most expensive rule to get wrong.
  for (const template of ['on_my_way', 'booking_confirmation', 'nurture_touch']) {
    const r = guardOutboundSms(
      { template, body: 'hello', optedOut: true, consented: true, now: NINE_AM },
      ENV
    );
    assert.equal(r.allow, false);
    assert.equal(r.action, 'drop');
    assert.match(r.reason, /opted out/);
  }
});

test('a customer with no consent on record is never texted', () => {
  const r = guardOutboundSms(
    { template: 'booking_confirmation', body: 'hello', optedOut: false, consented: false, now: NINE_AM },
    ENV
  );
  assert.equal(r.allow, false);
  assert.match(r.reason, /consent/);
});

test('an empty body is dropped rather than sent', () => {
  const r = guardOutboundSms(
    { template: 'on_my_way', body: '   ', optedOut: false, consented: true, now: NINE_AM },
    ENV
  );
  assert.equal(r.allow, false);
});

// --- quiet hours ----------------------------------------------------------

test('quiet hours wrap around midnight correctly', () => {
  assert.equal(inQuietHours(NINE_PM, QUIET, TZ), true,  '21:30 local is quiet');
  assert.equal(inQuietHours(SIX_AM,  QUIET, TZ), true,  '06:00 local is quiet');
  assert.equal(inQuietHours(NINE_AM, QUIET, TZ), false, '09:00 local is fine');
});

test('a marketing message inside quiet hours is deferred, not dropped', () => {
  // Dropping it means a missed appointment. Holding it until 8am costs nothing.
  const r = guardOutboundSms(
    { template: 't24_confirm', body: 'Reply YES', optedOut: false, consented: true, now: NINE_PM },
    ENV
  );
  assert.equal(r.action, 'defer');
  assert.ok(r.deferUntil);
  assert.equal(inQuietHours(new Date(r.deferUntil), QUIET, TZ), false,
    'the deferred time must itself be outside quiet hours');
});

test('deferral lands at the start of the next allowed hour', () => {
  const until = nextSendableTime(NINE_PM, QUIET, TZ);
  // 08:00 America/Chicago on 16 Jan = 14:00 UTC.
  assert.equal(until.toISOString(), '2026-01-16T14:00:00.000Z');
});

test('a time already outside quiet hours is not deferred', () => {
  assert.equal(nextSendableTime(NINE_AM, QUIET, TZ).getTime(), NINE_AM.getTime());
});

test('transactional messages are exempt from quiet hours', () => {
  // Someone booking an emergency call at 11pm expects an immediate
  // confirmation, and the "on my way" text is useless if held until morning.
  for (const template of ['booking_confirmation', 'on_my_way', 'help_response', 'stop_confirmation']) {
    const r = guardOutboundSms(
      { template, body: 'x', optedOut: false, consented: true, now: NINE_PM },
      ENV
    );
    assert.equal(r.allow, true, `${template} should send at 21:30`);
  }
});

test('an unknown template is treated as marketing, the safe default', () => {
  const r = guardOutboundSms(
    { template: 'some_new_campaign', body: 'x', optedOut: false, consented: true, now: NINE_PM },
    ENV
  );
  assert.equal(r.action, 'defer');
  assert.equal(isTransactional('some_new_campaign'), false);
});

// --- cost -----------------------------------------------------------------

test('segment counting matches GSM-7 boundaries', () => {
  assert.deepEqual(countSegments('hello'),         { encoding: 'GSM-7', length: 5,   segments: 1 });
  assert.deepEqual(countSegments('x'.repeat(160)), { encoding: 'GSM-7', length: 160, segments: 1 });
  assert.deepEqual(countSegments('x'.repeat(161)), { encoding: 'GSM-7', length: 161, segments: 2 });
  assert.equal(countSegments('x'.repeat(306)).segments, 2);
  assert.equal(countSegments('x'.repeat(307)).segments, 3);
});

test('a single emoji forces UCS-2 and shrinks the segment limit', () => {
  // The invisible cost: adding an emoji to a long message can take it from
  // 1 segment to 3. At thousands of messages a month that is real money.
  const plain = countSegments('x'.repeat(100));
  const withEmoji = countSegments('x'.repeat(100) + '\u{1F44D}');

  assert.equal(plain.encoding, 'GSM-7');
  assert.equal(plain.segments, 1);
  assert.equal(withEmoji.encoding, 'UCS-2');
  assert.ok(withEmoji.segments > 1, 'emoji should push it past one segment');
});

test('every guard result reports what the message will cost', () => {
  const r = guardOutboundSms(
    { template: 'on_my_way', body: 'Dave is on the way', optedOut: false, consented: true, now: NINE_AM },
    ENV
  );
  assert.equal(r.allow, true);
  assert.equal(r.cost.segments, 1);
  assert.equal(r.cost.encoding, 'GSM-7');
});
