'use strict';

/**
 * Booking payload validation and normalisation — the front door.
 *
 * The booking webhook is public: anything can POST to it. Everything
 * downstream (dispatch, SMS, invoicing) assumes clean, normalised data, so it
 * gets cleaned exactly once, here.
 *
 * The single most important job in this file is phone normalisation. Twilio
 * rejects anything that is not E.164 (+15125551234). Customers type
 * "(512) 555-1234", "512.555.1234", "1-512-555-1234". Get this wrong and the
 * confirmation text silently never sends.
 */

const { JOB_TYPE_SKILLS } = require('./partner-scoring.js');

const VALID_JOB_TYPES = Object.keys(JOB_TYPE_SKILLS);
const VALID_URGENCY = ['emergency', 'standard', 'flexible'];

/**
 * Normalise a US/Canada phone number to E.164.
 * Returns null if it cannot be made valid — callers must treat null as a
 * hard validation failure, never as "send anyway".
 */
function normalisePhone(input, defaultCountryCode = '1') {
  if (!input) return null;

  const raw = String(input).trim();

  // Already E.164 with a non-NANP country code — accept as-is if plausible.
  if (/^\+(?!1)\d{7,15}$/.test(raw)) return raw;

  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // 10 digits: bare NANP number.
  if (digits.length === 10) {
    if (!isValidNanp(digits)) return null;
    return `+${defaultCountryCode}${digits}`;
  }

  // 11 digits starting with 1: NANP with country code.
  if (digits.length === 11 && digits.startsWith('1')) {
    const nsn = digits.slice(1);
    if (!isValidNanp(nsn)) return null;
    return `+${digits}`;
  }

  // International, entered without the plus.
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;

  return null;
}

/**
 * NANP rules: area code and exchange code both start 2-9. Catches the common
 * test-data junk (0000000000, 1234567890) before it reaches Twilio.
 */
function isValidNanp(tenDigits) {
  if (tenDigits.length !== 10) return false;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(tenDigits)) return false;
  if (/^(\d)\1{9}$/.test(tenDigits)) return false; // all same digit
  return true;
}

/** Pragmatic email check — deliberately not RFC 5322. */
function isValidEmail(value) {
  if (!value) return false;
  const s = String(value).trim();
  if (s.length > 254 || /\s/.test(s)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(s);
}

/**
 * Combine a preferred date and time window into a scheduled start.
 * @param {string} date    YYYY-MM-DD
 * @param {string} window  "08:00-12:00"
 * @param {string} timezone
 */
function resolveSchedule(date, window, timezone) {
  const [startTime, endTime] = String(window || '08:00-12:00').split('-');
  const start = zonedToUtc(date, startTime || '08:00', timezone);
  const end = zonedToUtc(date, endTime || '12:00', timezone);
  return { start, end };
}

/**
 * Interpret "2026-09-04 08:00 in America/Chicago" as a real UTC instant.
 *
 * Node has no built-in zoned-time constructor, so we probe: guess UTC, ask
 * Intl what that instant looks like in the target zone, and correct by the
 * difference. Two passes settle DST boundaries.
 */
function zonedToUtc(dateStr, timeStr, timezone) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr).split(':').map(Number);

  let utc = Date.UTC(y, m - 1, d, hh, mm || 0, 0);

  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utc));

    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asSeenInZone = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const target = Date.UTC(y, m - 1, d, hh, mm || 0, 0);
    const drift = target - asSeenInZone;
    if (drift === 0) break;
    utc += drift;
  }

  return new Date(utc).toISOString();
}

/**
 * Validate and normalise a booking submission.
 *
 * @returns {{ok: boolean, errors: string[], value: object|null}}
 *   Never throws — the webhook branches on `ok` and returns a 400 with
 *   `errors` so the website form can show the customer what to fix.
 */
function validateBooking(payload, env = process.env) {
  const errors = [];
  const p = payload || {};
  const timezone = env.BUSINESS_TIMEZONE || 'America/Chicago';

  const fullName = String(p.full_name || '').trim();
  if (fullName.length < 2) errors.push('full_name is required');

  const email = String(p.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) errors.push('a valid email is required');

  const phone = normalisePhone(p.phone);
  if (!phone) errors.push('a valid phone number is required');

  const addressLine = String(p.address_line || '').trim();
  if (addressLine.length < 4) errors.push('address_line is required');

  const jobType = String(p.job_type || '').trim();
  if (!VALID_JOB_TYPES.includes(jobType)) {
    errors.push(`job_type must be one of: ${VALID_JOB_TYPES.join(', ')}`);
  }

  const urgency = String(p.urgency || 'standard').trim();
  if (!VALID_URGENCY.includes(urgency)) {
    errors.push(`urgency must be one of: ${VALID_URGENCY.join(', ')}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.preferred_date || ''))) {
    errors.push('preferred_date must be YYYY-MM-DD');
  }

  // Consent is not optional. Texting someone who never agreed is a TCPA
  // violation at up to $1,500 per message — so a booking without consent is
  // rejected outright rather than quietly downgraded to email-only.
  if (p.sms_consent !== true && p.sms_consent !== 'true' && p.sms_consent !== 'on') {
    errors.push('sms_consent is required to send appointment reminders');
  }

  if (errors.length) return { ok: false, errors, value: null };

  const { start, end } = resolveSchedule(p.preferred_date, p.preferred_window, timezone);

  return {
    ok: true,
    errors: [],
    value: {
      customer: {
        full_name: fullName,
        email,
        phone,
        address_line: addressLine,
        city: String(p.city || '').trim() || null,
        state: String(p.state || '').trim() || null,
        postal_code: String(p.postal_code || '').trim() || null,
        sms_consent: true,
        sms_consent_at: new Date().toISOString(),
        sms_consent_source: String(p.sms_consent_source || 'booking_form_v1'),
      },
      job: {
        job_type: jobType,
        urgency,
        description: String(p.description || '').trim().slice(0, 2000) || null,
        scheduled_start: start,
        scheduled_end: end,
        timezone,
      },
    },
  };
}

/** Full address string for geocoding. */
function fullAddress(customer) {
  return [customer.address_line, customer.city, customer.state, customer.postal_code]
    .filter(Boolean)
    .join(', ');
}

module.exports = {
  validateBooking,
  normalisePhone,
  isValidEmail,
  isValidNanp,
  resolveSchedule,
  zonedToUtc,
  fullAddress,
  VALID_JOB_TYPES,
  VALID_URGENCY,
};
