'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateBooking,
  normalisePhone,
  isValidEmail,
  zonedToUtc,
  fullAddress,
} = require('../lib/validation.js');

const ENV = { BUSINESS_TIMEZONE: 'America/Chicago' };

const goodBooking = (over = {}) => ({
  full_name: 'Dana Reyes',
  email: 'Dana.Reyes@Example.com',
  phone: '(512) 555-1234',
  address_line: '4412 Red Oak Lane',
  city: 'Austin',
  state: 'TX',
  postal_code: '78745',
  job_type: 'water_heater',
  urgency: 'standard',
  preferred_date: '2026-09-04',
  preferred_window: '08:00-12:00',
  sms_consent: true,
  ...over,
});

// --- phone normalisation --------------------------------------------------

test('common US phone formats all normalise to the same E.164 number', () => {
  const expected = '+15125551234';
  for (const input of [
    '(512) 555-1234',
    '512-555-1234',
    '512.555.1234',
    '5125551234',
    '1-512-555-1234',
    '+1 512 555 1234',
    '  +15125551234  ',
  ]) {
    assert.equal(normalisePhone(input), expected, `failed on "${input}"`);
  }
});

test('invalid phone numbers return null, never a guess', () => {
  // Twilio rejects these; sending anyway means a silent delivery failure.
  for (const bad of ['', null, undefined, '123', '555-1234', '0000000000', '1112223333', 'not a phone']) {
    assert.equal(normalisePhone(bad), null, `should have rejected ${JSON.stringify(bad)}`);
  }
});

test('non-NANP international numbers pass through', () => {
  assert.equal(normalisePhone('+447700900123'), '+447700900123');
  assert.equal(normalisePhone('447700900123'), '+447700900123');
});

// --- email ----------------------------------------------------------------

test('email validation accepts real addresses and rejects malformed ones', () => {
  for (const ok of ['a@b.co', 'dana.reyes@example.com', 'x+tag@sub.example.co.uk']) {
    assert.ok(isValidEmail(ok), `${ok} should be valid`);
  }
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@@b.com', null]) {
    assert.ok(!isValidEmail(bad), `${JSON.stringify(bad)} should be invalid`);
  }
});

// --- timezone -------------------------------------------------------------

test('local booking times convert to the correct UTC instant across DST', () => {
  // Chicago is UTC-5 in September (CDT) and UTC-6 in January (CST). Getting
  // this wrong sends the T-24 reminder an hour off, twice a year.
  assert.equal(zonedToUtc('2026-09-04', '08:00', 'America/Chicago'), '2026-09-04T13:00:00.000Z');
  assert.equal(zonedToUtc('2026-01-04', '08:00', 'America/Chicago'), '2026-01-04T14:00:00.000Z');
});

test('timezone conversion works for a second zone', () => {
  // Los Angeles, UTC-7 in summer.
  assert.equal(zonedToUtc('2026-07-15', '09:00', 'America/Los_Angeles'), '2026-07-15T16:00:00.000Z');
});

// --- full validation ------------------------------------------------------

test('a good booking validates and comes back normalised', () => {
  const result = validateBooking(goodBooking(), ENV);

  assert.ok(result.ok, result.errors.join('; '));
  assert.equal(result.value.customer.phone, '+15125551234');
  assert.equal(result.value.customer.email, 'dana.reyes@example.com', 'email should be lowercased');
  assert.equal(result.value.job.job_type, 'water_heater');
  assert.equal(result.value.job.scheduled_start, '2026-09-04T13:00:00.000Z');
  assert.equal(result.value.job.scheduled_end, '2026-09-04T17:00:00.000Z');
  assert.ok(result.value.customer.sms_consent_at, 'consent timestamp must be recorded');
});

test('validation never throws, it returns errors', () => {
  // The webhook is public. A malformed body must produce a 400, not a crashed
  // execution that loses the booking entirely.
  for (const junk of [null, undefined, {}, { full_name: 123 }, 'a string']) {
    const result = validateBooking(junk, ENV);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.equal(result.value, null);
  }
});

test('missing SMS consent rejects the booking outright', () => {
  const result = validateBooking(goodBooking({ sms_consent: false }), ENV);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /sms_consent/.test(e)));
});

test('checkbox-style consent values are accepted', () => {
  // An HTML checkbox posts "on", and some form builders post the string "true".
  for (const value of [true, 'true', 'on']) {
    assert.ok(validateBooking(goodBooking({ sms_consent: value }), ENV).ok, `failed on ${value}`);
  }
});

test('an unknown job type is rejected with the valid list', () => {
  const result = validateBooking(goodBooking({ job_type: 'hovercraft_repair' }), ENV);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /job_type must be one of/.test(e)));
});

test('all validation errors are collected, not just the first', () => {
  // The form should be able to highlight every bad field at once.
  const result = validateBooking(
    { full_name: '', email: 'nope', phone: '123', address_line: '', job_type: 'x', preferred_date: 'soon' },
    ENV
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5, `expected several errors, got ${result.errors.length}`);
});

test('a long description is truncated rather than rejected', () => {
  const result = validateBooking(goodBooking({ description: 'x'.repeat(5000) }), ENV);
  assert.ok(result.ok);
  assert.equal(result.value.job.description.length, 2000);
});

test('fullAddress skips missing parts without leaving stray commas', () => {
  assert.equal(
    fullAddress({ address_line: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78745' }),
    '1 Main St, Austin, TX, 78745'
  );
  assert.equal(fullAddress({ address_line: '1 Main St', city: null, state: 'TX' }), '1 Main St, TX');
});
