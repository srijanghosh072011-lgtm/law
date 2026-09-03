'use strict';

/**
 * SMS compliance guard — sits in front of every single outbound text.
 *
 * This is not paperwork. Under the US TCPA, texting someone who opted out, or
 * texting outside permitted hours, carries statutory damages of $500–$1,500
 * PER MESSAGE. An automation that sends hundreds of texts a month turns a
 * configuration mistake into a five-figure problem very quickly.
 *
 * So: nothing calls twilio.sendSms directly. Everything goes through
 * guardOutboundSms first, and a blocked message is logged, not sent.
 *
 * See docs/COMPLIANCE.md for the registration side (A2P 10DLC).
 */

const { business } = require('./config.js');

/** Message classes. Only transactional messages may bypass quiet hours. */
const TRANSACTIONAL = new Set([
  'booking_confirmation',   // they just clicked book — they expect this
  'partner_dispatch',       // goes to staff, not a customer
  'on_my_way',              // the van is literally outside
  'help_response',          // carrier-mandated reply
  'stop_confirmation',      // carrier-mandated reply
]);

/**
 * Which messages are marketing, and therefore strictly quiet-hours bound and
 * opt-out bound. Anything not listed as transactional is treated as marketing,
 * which is the safe default.
 */
function isTransactional(template) {
  return TRANSACTIONAL.has(template);
}

/**
 * The local hour for a phone's owner.
 *
 * NOTE ON A REAL LIMITATION: we use the *business* timezone, not the
 * customer's. For a local plumber serving one metro that is correct and
 * simple. If a client ever serves multiple timezones, this must switch to a
 * per-customer timezone resolved from their address — otherwise you will text
 * someone at 6am. Flagged rather than silently assumed.
 */
function localHour(date, timezone) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(date)
  );
}

/**
 * Is `date` inside quiet hours?
 * Quiet hours wrap midnight: start 21, end 8 means 21:00–07:59 is quiet.
 */
function inQuietHours(date, { start, end }, timezone) {
  const hour = localHour(date, timezone);
  if (start === end) return false;          // disabled
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;       // wraps midnight
}

/**
 * The next moment it becomes legal to send.
 * Used to DEFER a message rather than drop it — a reminder held until 8am is
 * still useful; a dropped one is a missed appointment.
 */
function nextSendableTime(date, { start, end }, timezone) {
  if (!inQuietHours(date, { start, end }, timezone)) return new Date(date);

  const next = new Date(date);
  // Step forward an hour at a time. Cheap, and correct across DST because
  // every step re-reads the local hour rather than doing date arithmetic.
  for (let i = 0; i < 24; i += 1) {
    next.setTime(next.getTime() + 3600000);
    if (!inQuietHours(next, { start, end }, timezone)) {
      next.setMinutes(0, 0, 0);
      return next;
    }
  }
  return next;
}

/**
 * GSM-7 vs UCS-2 segment counting.
 *
 * Why it matters: one emoji forces the whole message into UCS-2, which cuts
 * the per-segment limit from 153 characters to 67. A 160-character text with a
 * single 👍 in it costs three segments instead of one. At a few thousand
 * messages a month that is a real line item, and it is invisible until the
 * bill arrives.
 */
const GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);
const GSM7_EXTENDED = new Set('^{}\\[~]|€');

function countSegments(body) {
  const text = String(body || '');
  const chars = [...text];

  const isGsm = chars.every((c) => GSM7.has(c) || GSM7_EXTENDED.has(c));

  if (isGsm) {
    // Extended characters take two septets each.
    const length = chars.reduce((n, c) => n + (GSM7_EXTENDED.has(c) ? 2 : 1), 0);
    if (length <= 160) return { encoding: 'GSM-7', length, segments: 1 };
    return { encoding: 'GSM-7', length, segments: Math.ceil(length / 153) };
  }

  // UCS-2. Characters outside the BMP (most emoji) take two units.
  const length = text.length;
  if (length <= 70) return { encoding: 'UCS-2', length, segments: 1 };
  return { encoding: 'UCS-2', length, segments: Math.ceil(length / 67) };
}

/**
 * The gate. Decide whether an SMS may be sent right now.
 *
 * @param {object} opts
 *   @param {string} opts.template   e.g. 't24_confirm'
 *   @param {string} opts.body
 *   @param {boolean} opts.optedOut  from the sms_optouts table
 *   @param {boolean} opts.consented from customers.sms_consent
 *   @param {Date}   [opts.now]
 * @param {object} env
 * @returns {{allow: boolean, action: string, reason: string, deferUntil: string|null, cost: object}}
 *   action is 'send' | 'defer' | 'drop'
 */
function guardOutboundSms({ template, body, optedOut, consented, now = new Date() }, env = process.env) {
  const biz = business(env);
  const cost = countSegments(body);
  const deny = (reason) => ({ allow: false, action: 'drop', reason, deferUntil: null, cost });

  // 1. Opt-out is absolute. No template, however transactional, overrides a
  //    STOP. This check comes first for exactly that reason.
  if (optedOut) {
    return deny('recipient has opted out (STOP)');
  }

  // 2. No consent on file means we were never allowed to text them.
  if (consented === false) {
    return deny('no SMS consent on record for this customer');
  }

  if (!String(body || '').trim()) {
    return deny('empty message body');
  }

  // 3. Quiet hours. Transactional messages are exempt — a customer who booked
  //    an emergency call at 11pm expects a confirmation at 11pm.
  if (!isTransactional(template) && inQuietHours(now, biz.quietHours, biz.timezone)) {
    const until = nextSendableTime(now, biz.quietHours, biz.timezone);
    return {
      allow: false,
      action: 'defer',
      reason: `quiet hours (${biz.quietHours.start}:00–${biz.quietHours.end}:00 ${biz.timezone})`,
      deferUntil: until.toISOString(),
      cost,
    };
  }

  return { allow: true, action: 'send', reason: 'ok', deferUntil: null, cost };
}

/** Carrier-mandated auto-replies. Both must be answered, every time. */
function stopConfirmationText(env = process.env) {
  const biz = business(env);
  return `${biz.name}: You're unsubscribed and won't get any more texts from us. Reply START to resubscribe. For help call ${biz.phone}.`;
}

function helpText(env = process.env) {
  const biz = business(env);
  return `${biz.name}: Appointment reminders and arrival notices. Call ${biz.phone} for help. Reply STOP to unsubscribe. Msg&data rates may apply.`;
}

module.exports = {
  guardOutboundSms,
  inQuietHours,
  nextSendableTime,
  countSegments,
  isTransactional,
  localHour,
  stopConfirmationText,
  helpText,
  TRANSACTIONAL,
};
