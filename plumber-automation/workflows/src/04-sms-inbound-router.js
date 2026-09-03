'use strict';

/**
 * Workflow 04 — Inbound SMS Router.  Spec steps 5, 6, 7.
 *
 * Twilio POSTs every inbound text here. We work out what the customer meant
 * and branch:
 *
 *   YES      -> confirmed, queued for tomorrow's route            (step 7)
 *   NO  #1   -> reschedule sequence, booking link                 (step 5)
 *   NO  #2   -> nurture sequence for future bookings              (step 6)
 *   STOP     -> opt out, suppress everything, confirm as required
 *   HELP     -> carrier-mandated help reply
 *   UNCLEAR  -> a human reads it. Never guessed.
 *
 * Twilio endpoint:  POST http://<public-url>/webhook/sms-inbound
 */

const { workflow, webhook, code, postgres, switchNode, respond, LIB } = require('./_builder.js');

module.exports = workflow({
  name: '04 · SMS Inbound Router',
  tags: ['plumber'],
  notes: `## 04 · SMS Inbound Router\n\n**Trigger:** Twilio posts every inbound SMS here.\n\n**Branches:** YES → confirmed · NO (1st) → reschedule · NO (2nd) → nurture · STOP → opt out · HELP → carrier reply · UNCLEAR → a human.\n\nThe UNCLEAR branch is the point of the design: "yes but can we move it" is never collapsed into a confirmation.\n\nCovers spec steps **5**, **6** and **7**.`,

  nodes: [
    webhook('Twilio Inbound SMS', 'sms-inbound'),

    code('Parse Intent', `${LIB}
const { parseSmsReply } = require(LIB + '/sms-parser.js');
const { normalisePhone } = require(LIB + '/validation.js');

// Twilio posts form-encoded; n8n exposes it under .body.
const payload = $input.first().json.body ?? $input.first().json;
const from = normalisePhone(payload.From || payload.from);
const body = payload.Body ?? payload.body ?? '';

if (!from) {
  return [{ json: { error: 'inbound SMS with no usable From number', intent: 'IGNORE' } }];
}

const parsed = parseSmsReply(body);

return [{ json: {
  from,
  body,
  intent: parsed.intent,
  confidence: parsed.confidence,
  reason: parsed.reason,
  messageSid: payload.MessageSid || null,
} }];`),

    // Match the reply to the job we actually asked about: the most recent one
    // where we sent a confirmation and haven't had an answer.
    postgres('Find Awaiting Job', `SELECT
  j.id AS job_id, j.job_type, j.scheduled_start, j.timezone, j.status,
  j.decline_count, j.ghl_opportunity_id,
  c.id AS customer_id, c.full_name, c.email, c.phone, c.ghl_contact_id
FROM jobs j
JOIN customers c ON c.id = j.customer_id
WHERE c.phone = '{{ $json.from }}'
  AND j.status IN ('assigned', 'booked', 'unconfirmed', 'rescheduling')
ORDER BY
  (j.confirm_sent_at IS NOT NULL AND j.confirm_response IS NULL) DESC,
  j.scheduled_start ASC
LIMIT 1;`),

    code('Merge Reply & Job', `${LIB}
const { decideRoute } = require(LIB + '/reply-routing.js');

const reply = $('Parse Intent').first().json;
const job = $input.first().json;
const hasJob = Boolean(job && job.job_id);

// The branch decision lives in lib/reply-routing.js so it is unit-tested
// rather than buried in this node.
const decision = decideRoute({
  intent: reply.intent,
  hasJob,
  declineCount: hasJob ? (job.decline_count || 0) : 0,
});

return [{ json: {
  ...reply,
  hasJob,
  job: hasJob ? job : null,
  route: decision.route,
  routeWhy: decision.why,
} }];`),

    switchNode('Route Reply', [
      { label: 'yes',      condition: "$json.route === 'YES'" },
      { label: 'no_first', condition: "$json.route === 'NO_FIRST'" },
      { label: 'no_again', condition: "$json.route === 'NO_AGAIN'" },
      { label: 'stop',     condition: "$json.route === 'STOP'" },
      { label: 'help',     condition: "$json.route === 'HELP'" },
    ]),

    // ---------------- YES: confirmed (spec step 7) ----------------------
    postgres('Mark Confirmed', `UPDATE jobs
SET status = 'confirmed', confirm_response = 'YES', confirm_responded_at = NOW()
WHERE id = '{{ $json.job.job_id }}'
RETURNING *;`),

    code('Send Confirmed Reply', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');

const ctx = $('Merge Reply & Job').first().json;
const { twilio, ghl } = services(env);
const t = templates(env);

await twilio.sendSms({
  to: ctx.from,
  body: t.confirmedSms({ job: { scheduled_start: ctx.job.scheduled_start } }),
});

// Move the CRM card so the owner's pipeline reflects reality.
if (ctx.job.ghl_opportunity_id) {
  await ghl.moveOpportunity(ctx.job.ghl_opportunity_id, env.GHL_STAGE_CONFIRMED_ID || 'confirmed');
}
if (ctx.job.ghl_contact_id) {
  await ghl.tagContact(ctx.job.ghl_contact_id, ['confirmed-appointment']);
}

return [{ json: { jobId: ctx.job.job_id, outcome: 'confirmed' } }];`),

    // ---------------- NO, first time: reschedule (step 5) ---------------
    postgres('Mark Rescheduling', `UPDATE jobs
SET status = 'rescheduling', confirm_response = 'NO', confirm_responded_at = NOW(),
    decline_count = decline_count + 1, partner_id = NULL
WHERE id = '{{ $json.job.job_id }}'
RETURNING *;`),

    code('Send Reschedule Link', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');
const { guardOutboundSms } = require(LIB + '/compliance.js');

const ctx = $('Merge Reply & Job').first().json;
const { twilio, email, ghl } = services(env);
const t = templates(env);

const body = t.rescheduleSms();
// A reply to their own message is transactional, so it is not quiet-hours
// blocked — someone texting "no" at 10pm should get the link straight away.
const gate = guardOutboundSms({
  template: 'booking_confirmation', body, optedOut: false, consented: true,
}, env);

if (gate.allow) {
  await twilio.sendSms({ to: ctx.from, body });
}

const mail = t.rescheduleEmail({ customer: { full_name: ctx.job.full_name } });
await email.send({ to: ctx.job.email, subject: mail.subject, html: mail.html });

if (ctx.job.ghl_contact_id) {
  await ghl.tagContact(ctx.job.ghl_contact_id, ['rescheduling']);
}

return [{ json: { jobId: ctx.job.job_id, outcome: 'rescheduling' } }];`),

    // ---------------- NO again: nurture (step 6) ------------------------
    postgres('Mark Nurture', `UPDATE jobs
SET status = 'nurture', confirm_response = 'NO', confirm_responded_at = NOW(),
    decline_count = decline_count + 1, partner_id = NULL
WHERE id = '{{ $json.job.job_id }}'
RETURNING *;`),

    code('Enroll in Nurture', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');

const ctx = $('Merge Reply & Job').first().json;
const { twilio, ghl } = services(env);
const t = templates(env);

// They have now declined twice. Stop chasing this booking — one short,
// friendly close, then long-cycle nurture. Chasing a third time is how a
// business earns spam complaints.
await twilio.sendSms({ to: ctx.from, body: t.nurtureSms() });

if (ctx.job.ghl_contact_id) {
  await ghl.tagContact(ctx.job.ghl_contact_id, ['nurture', 'declined-twice']);
  await ghl.enrollInCampaign(ctx.job.ghl_contact_id, 'declined_reactivation');
}

return [{ json: { jobId: ctx.job.job_id, customerId: ctx.job.customer_id, outcome: 'nurture' } }];`),

    postgres('Record Nurture Enrollment', `INSERT INTO nurture_enrollments (customer_id, job_id, campaign, next_touch_at)
VALUES ('{{ $json.customerId }}', '{{ $json.jobId }}', 'declined_reactivation', NOW() + INTERVAL '30 days')
ON CONFLICT (customer_id, campaign) DO UPDATE SET next_touch_at = EXCLUDED.next_touch_at;`),

    // ---------------- STOP: opt out -------------------------------------
    postgres('Record Opt-Out', `INSERT INTO sms_optouts (phone, reason)
VALUES ('{{ $json.from }}', 'STOP')
ON CONFLICT (phone) DO NOTHING;`),

    code('Confirm Opt-Out', `${LIB}
const { services } = require(LIB + '/services.js');
const { stopConfirmationText } = require(LIB + '/compliance.js');

const ctx = $('Merge Reply & Job').first().json;
const { twilio } = services(env);

// The opt-out confirmation is the one message you are still required to send
// after a STOP. Exactly one — never a follow-up.
await twilio.sendSms({ to: ctx.from, body: stopConfirmationText(env) });

return [{ json: { phone: ctx.from, outcome: 'opted_out' } }];`),

    // ---------------- HELP ----------------------------------------------
    code('Send Help Text', `${LIB}
const { services } = require(LIB + '/services.js');
const { helpText } = require(LIB + '/compliance.js');

const ctx = $('Merge Reply & Job').first().json;
const { twilio } = services(env);

await twilio.sendSms({ to: ctx.from, body: helpText(env) });
return [{ json: { phone: ctx.from, outcome: 'help_sent' } }];`),

    // ---------------- UNCLEAR / no job: escalate ------------------------
    // The safety valve. Rather than guessing, put it in front of a person.
    code('Escalate to Human', `${LIB}
const { services } = require(LIB + '/services.js');
const ctx = $input.first().json;
const { email } = services(env);

const detail = [
  'A customer replied to an appointment text and the system could not tell',
  'whether it was a yes or a no.',
  '',
  'From:    ' + ctx.from,
  'Message: "' + ctx.body + '"',
  'Why:     ' + ctx.reason,
  '',
  ctx.hasJob
    ? 'Job:     ' + ctx.job.job_type + ' on ' + ctx.job.scheduled_start + ' for ' + ctx.job.full_name
    : 'No open appointment matched this number.',
  '',
  'Reply to the customer directly. The appointment has not been changed.',
].join('\\n');

await email.send({
  to: env.BUSINESS_EMAIL || 'dispatch@example-plumbing.com',
  subject: 'Needs a human: unclear reply from ' + ctx.from,
  text: detail,
  html: '<pre style="font:14px ui-monospace,Menlo,monospace;white-space:pre-wrap;">' + detail + '</pre>',
});

return [{ json: { outcome: 'escalated', from: ctx.from, reason: ctx.reason } }];`),

    postgres('Log Inbound', `INSERT INTO messages (job_id, customer_id, channel, direction, template, to_addr, body, provider_id)
VALUES (
  {{ $('Merge Reply & Job').first().json.hasJob ? "'" + $('Merge Reply & Job').first().json.job.job_id + "'" : 'NULL' }},
  {{ $('Merge Reply & Job').first().json.hasJob ? "'" + $('Merge Reply & Job').first().json.job.customer_id + "'" : 'NULL' }},
  'sms', 'inbound',
  '{{ $('Parse Intent').first().json.intent }}',
  '{{ $('Parse Intent').first().json.from }}',
  {{ JSON.stringify($('Parse Intent').first().json.body) }},
  {{ $('Parse Intent').first().json.messageSid ? "'" + $('Parse Intent').first().json.messageSid + "'" : 'NULL' }}
);`,
      { alwaysOutputData: true }),

    // Twilio wants TwiML or an empty 200. We already sent any reply through
    // the API, so an empty response avoids Twilio sending a second message.
    respond('Empty 200 to Twilio', { body: '={{ "" }}' }),
  ],

  connections: [
    ['Twilio Inbound SMS', 'Parse Intent'],
    ['Parse Intent', 'Find Awaiting Job'],
    ['Find Awaiting Job', 'Merge Reply & Job'],
    ['Merge Reply & Job', 'Route Reply'],

    ['Route Reply', 'Mark Confirmed', 0],
    ['Route Reply', 'Mark Rescheduling', 1],
    ['Route Reply', 'Mark Nurture', 2],
    ['Route Reply', 'Record Opt-Out', 3],
    ['Route Reply', 'Send Help Text', 4],
    ['Route Reply', 'Escalate to Human', 5],   // fallback: UNCLEAR / NO_JOB

    ['Mark Confirmed', 'Send Confirmed Reply'],
    ['Mark Rescheduling', 'Send Reschedule Link'],
    ['Mark Nurture', 'Enroll in Nurture'],
    ['Enroll in Nurture', 'Record Nurture Enrollment'],
    ['Record Opt-Out', 'Confirm Opt-Out'],

    ['Send Confirmed Reply', 'Log Inbound'],
    ['Send Reschedule Link', 'Log Inbound'],
    ['Record Nurture Enrollment', 'Log Inbound'],
    ['Confirm Opt-Out', 'Log Inbound'],
    ['Send Help Text', 'Log Inbound'],
    ['Escalate to Human', 'Log Inbound'],

    ['Log Inbound', 'Empty 200 to Twilio'],
  ],
});
