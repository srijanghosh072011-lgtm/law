'use strict';

/**
 * Workflow 03 — T-24 Confirmation.  Spec step 4.
 *
 * "Wait 24 hours before the appointment and send a confirmation SMS asking
 * them yes or no if they're good to go."
 *
 * Runs hourly rather than scheduling a timer per job. That is deliberate: a
 * per-job wait node holds an execution open for a day, and every one of them
 * is lost if n8n restarts. A cron that asks "what needs a reminder now?"
 * survives restarts, backfills anything missed, and is trivial to reason about.
 *
 * Three jobs in one pass:
 *   1. ~24h out, never asked        -> send the yes/no confirmation
 *   2. ~12h out, asked, no reply    -> send one nudge
 *   3.  ~3h out, still no reply     -> stop asking, flag it for the plumber
 */

const { workflow, schedule, code, postgres, LIB } = require('./_builder.js');

module.exports = workflow({
  name: '03 · T-24 Confirmation',
  tags: ['plumber'],
  notes: `## 03 · T-24 Confirmation\n\n**Trigger:** hourly cron (not a per-job timer — those die on restart).\n\n**Does three sweeps each run:**\n1. ~24h out, never asked → yes/no SMS\n2. ~12h out, asked, silent → one nudge\n3. ~3h out, still silent → mark unconfirmed and tell the plumber\n\nQuiet-hours-blocked messages are deferred to the next allowed hour, not dropped.\n\nCovers spec step **4**, plus the silence path the original spec didn't have.`,

  nodes: [
    schedule('Every Hour', '0 * * * *'),

    // Window is 23-25h rather than "exactly 24h" so an hourly cron cannot
    // miss a job that falls between two runs.
    postgres('Find Jobs ~24h Out', `SELECT
  j.id AS job_id, j.job_type, j.scheduled_start, j.timezone, j.status,
  c.id AS customer_id, c.full_name, c.phone, c.email, c.sms_consent,
  (o.phone IS NOT NULL) AS opted_out
FROM jobs j
JOIN customers c ON c.id = j.customer_id
LEFT JOIN sms_optouts o ON o.phone = c.phone
WHERE j.status IN ('assigned', 'booked')
  AND j.confirm_sent_at IS NULL
  AND j.scheduled_start BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours';`),

    code('Send Confirmations', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');
const { guardOutboundSms } = require(LIB + '/compliance.js');

const { twilio } = services(env);
const t = templates(env);
const out = [];

for (const item of $input.all()) {
  const row = item.json;
  if (!row || !row.job_id) continue;

  const customer = { full_name: row.full_name, phone: row.phone, email: row.email };
  const job = { job_type: row.job_type, scheduled_start: row.scheduled_start };
  const body = t.t24ConfirmSms({ customer, job });

  // Never send without asking the guard first.
  const gate = guardOutboundSms({
    template: 't24_confirm',
    body,
    optedOut: row.opted_out,
    consented: row.sms_consent,
  }, env);

  if (!gate.allow) {
    // 'defer' leaves confirm_sent_at NULL, so the next hourly run picks it up
    // again once quiet hours have passed. 'drop' is terminal.
    out.push({ json: { jobId: row.job_id, sent: false, action: gate.action, reason: gate.reason } });
    continue;
  }

  await twilio.sendSms({ to: row.phone, body });
  out.push({ json: {
    jobId: row.job_id, customerId: row.customer_id, sent: true, action: 'send',
    segments: gate.cost.segments, body,
  } });
}

return out.length ? out : [{ json: { sent: false, action: 'none', reason: 'no jobs due' } }];`),

    postgres('Mark Confirmation Sent', `UPDATE jobs SET confirm_sent_at = NOW()
WHERE id = '{{ $json.jobId }}' AND {{ $json.sent }};`,
      { alwaysOutputData: true }),

    postgres('Log Outbound', `INSERT INTO messages (job_id, customer_id, channel, direction, template, to_addr, body)
SELECT '{{ $json.jobId }}', '{{ $json.customerId }}', 'sms', 'outbound', 't24_confirm', c.phone, {{ JSON.stringify($json.body || '') }}
FROM customers c WHERE c.id = '{{ $json.customerId }}'
AND {{ $json.sent }};`,
      { alwaysOutputData: true }),

    // --- sweep 2: one nudge for the silent -------------------------------
    postgres('Find Silent ~12h Out', `SELECT
  j.id AS job_id, j.job_type, j.scheduled_start, j.timezone,
  c.id AS customer_id, c.full_name, c.phone, c.sms_consent,
  (o.phone IS NOT NULL) AS opted_out
FROM jobs j
JOIN customers c ON c.id = j.customer_id
LEFT JOIN sms_optouts o ON o.phone = c.phone
WHERE j.status IN ('assigned', 'booked')
  AND j.confirm_sent_at IS NOT NULL
  AND j.confirm_response IS NULL
  AND j.nudge_sent_at IS NULL
  AND j.scheduled_start BETWEEN NOW() + INTERVAL '11 hours' AND NOW() + INTERVAL '13 hours';`),

    code('Send Nudges', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');
const { guardOutboundSms } = require(LIB + '/compliance.js');

const { twilio } = services(env);
const t = templates(env);
const out = [];

for (const item of $input.all()) {
  const row = item.json;
  if (!row || !row.job_id) continue;

  const body = t.t24NudgeSms({ job: { scheduled_start: row.scheduled_start } });
  const gate = guardOutboundSms({
    template: 't24_nudge', body, optedOut: row.opted_out, consented: row.sms_consent,
  }, env);

  if (!gate.allow) {
    out.push({ json: { jobId: row.job_id, nudged: false, reason: gate.reason } });
    continue;
  }

  await twilio.sendSms({ to: row.phone, body });
  out.push({ json: { jobId: row.job_id, nudged: true } });
}

return out.length ? out : [{ json: { nudged: false, reason: 'nobody to nudge' } }];`),

    postgres('Mark Nudged', `UPDATE jobs SET nudge_sent_at = NOW()
WHERE id = '{{ $json.jobId }}' AND {{ $json.nudged }};`,
      { alwaysOutputData: true }),

    // --- sweep 3: give up asking, tell a human ---------------------------
    // The van still rolls — an unanswered text is not a cancellation. But the
    // plumber gets told, so they can ring ahead rather than find nobody home.
    postgres('Find Still Silent ~3h Out', `UPDATE jobs SET status = 'unconfirmed'
WHERE status IN ('assigned', 'booked')
  AND confirm_sent_at IS NOT NULL
  AND confirm_response IS NULL
  AND scheduled_start BETWEEN NOW() + INTERVAL '2 hours' AND NOW() + INTERVAL '4 hours'
RETURNING id AS job_id, scheduled_start, customer_id;`),

    code('Alert Plumber — Unconfirmed', `${LIB}
const { services } = require(LIB + '/services.js');
const { email } = services(env);

const rows = $input.all().map(i => i.json).filter(r => r && r.job_id);
if (!rows.length) return [{ json: { alerted: 0 } }];

const lines = rows.map(r => '  - job ' + r.job_id + ' at ' + r.scheduled_start);
await email.send({
  to: env.BUSINESS_EMAIL || 'dispatch@example-plumbing.com',
  subject: rows.length + ' appointment(s) today never confirmed',
  text: [
    'These customers did not reply to the confirmation text or the nudge:',
    '',
    ...lines,
    '',
    'The jobs are still on the route. Worth a phone call before driving out.',
  ].join('\\n'),
});

return [{ json: { alerted: rows.length } }];`),
  ],

  connections: [
    ['Every Hour', 'Find Jobs ~24h Out'],
    ['Find Jobs ~24h Out', 'Send Confirmations'],
    ['Send Confirmations', 'Mark Confirmation Sent'],
    ['Mark Confirmation Sent', 'Log Outbound'],
    ['Log Outbound', 'Find Silent ~12h Out'],
    ['Find Silent ~12h Out', 'Send Nudges'],
    ['Send Nudges', 'Mark Nudged'],
    ['Mark Nudged', 'Find Still Silent ~3h Out'],
    ['Find Still Silent ~3h Out', 'Alert Plumber — Unconfirmed'],
  ],
});
