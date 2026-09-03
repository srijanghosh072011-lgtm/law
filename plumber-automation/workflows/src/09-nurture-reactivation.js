'use strict';

/**
 * Workflow 09 — Nurture & Reactivation.  Spec steps 6 and 15.
 *
 * The long game. Two campaigns run off one daily sweep:
 *
 *   post_job_maintenance   — 90 / 180 / 365 days after a completed job,
 *                            prompting a preventative check-up.
 *   declined_reactivation  — for people who declined twice and were let go.
 *
 * WHY A DAILY CRON RATHER THAN A WAIT NODE:
 * these touches are months apart. An n8n Wait node holding an execution open
 * for a year is not a real design — it dies with the first restart. The
 * enrolment row is the state; the cron just asks "who is due today?".
 *
 * There is also a sweep for jobs stuck mid-reschedule: a customer who said
 * "no" and never rebooked would otherwise sit in limbo forever.
 */

const { workflow, schedule, code, postgres, LIB } = require('./_builder.js');

module.exports = workflow({
  name: '09 · Nurture & Reactivation',
  tags: ['plumber'],
  notes: `## 09 · Nurture & Reactivation\n\n**Trigger:** daily at 10:00.\n\n**Does:** sends whichever long-cycle touch is due (90/180/365-day maintenance, or reactivation for people who declined twice), then schedules the next one.\n\nAlso sweeps up jobs abandoned mid-reschedule, which would otherwise sit in limbo forever.\n\nCovers spec steps **6** and **15**.`,

  nodes: [
    schedule('Daily 10:00', '0 10 * * *'),

    // --- sweep 1: abandoned reschedules ----------------------------------
    // Someone said "no", got the booking link, and never came back. After a
    // week, stop treating it as a live job and move them to nurture.
    postgres('Sweep Abandoned Reschedules', `UPDATE jobs SET status = 'nurture'
WHERE status = 'rescheduling'
  AND confirm_responded_at < NOW() - INTERVAL '7 days'
RETURNING id AS job_id, customer_id;`),

    code('Enroll Abandoned', `${LIB}
const rows = $input.all().map(i => i.json).filter(r => r && r.job_id);
if (!rows.length) return [{ json: { enrolled: 0 } }];
return rows.map(r => ({ json: { customerId: r.customer_id, jobId: r.job_id } }));`),

    postgres('Record Abandoned Enrollment', `INSERT INTO nurture_enrollments (customer_id, job_id, campaign, next_touch_at)
SELECT '{{ $json.customerId }}'::uuid, '{{ $json.jobId }}'::uuid, 'declined_reactivation', NOW() + INTERVAL '30 days'
WHERE '{{ $json.customerId }}' <> 'undefined'
ON CONFLICT (customer_id, campaign) DO NOTHING;`,
      { alwaysOutputData: true }),

    // --- sweep 2: whose touch is due today? ------------------------------
    postgres('Find Due Touches', `SELECT
  n.id AS enrollment_id, n.campaign, n.touches_sent, n.enrolled_at,
  c.id AS customer_id, c.full_name, c.email, c.phone, c.sms_consent,
  (o.phone IS NOT NULL) AS opted_out,
  j.job_type, j.scheduled_start AS last_job_at
FROM nurture_enrollments n
JOIN customers c ON c.id = n.customer_id
LEFT JOIN jobs j ON j.id = n.job_id
LEFT JOIN sms_optouts o ON o.phone = c.phone
WHERE n.completed = FALSE
  AND n.next_touch_at <= NOW()
  -- Somebody with a live job does not need a "come back" email.
  AND NOT EXISTS (
    SELECT 1 FROM jobs active
    WHERE active.customer_id = c.id
      AND active.status IN ('booked','assigned','confirmed','routed','en_route')
  )
LIMIT 200;`),

    code('Send Due Touches', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');
const { guardOutboundSms } = require(LIB + '/compliance.js');

const { email, twilio, ghl } = services(env);
const t = templates(env);

// Touch schedules, in days from enrolment. After the last one the enrolment
// is marked complete — a campaign that never ends is a campaign that gets
// reported as spam.
const SCHEDULES = {
  post_job_maintenance:  [90, 180, 365],
  declined_reactivation: [30, 120, 365],
};

const out = [];

for (const item of $input.all()) {
  const row = item.json;
  if (!row || !row.enrollment_id) continue;

  const schedule = SCHEDULES[row.campaign] || SCHEDULES.post_job_maintenance;
  const touchIndex = row.touches_sent || 0;

  if (touchIndex >= schedule.length) {
    out.push({ json: { enrollmentId: row.enrollment_id, done: true, sent: false } });
    continue;
  }

  const monthsSince = Math.round(schedule[touchIndex] / 30);
  const mail = t.maintenanceEmail({
    customer: { full_name: row.full_name },
    monthsSince,
  });

  await email.send({ to: row.email, subject: mail.subject, html: mail.html });

  // Email carries these campaigns; SMS is reserved for the appointment
  // itself. Marketing texts are what get a number's reputation destroyed,
  // and the reminder SMS is worth far more than the extra touch.
  if (row.ghl_contact_id) {
    await ghl.tagContact(row.ghl_contact_id, ['nurture-' + row.campaign]);
  }

  const nextIndex = touchIndex + 1;
  const isLast = nextIndex >= schedule.length;
  const nextDays = isLast ? null : schedule[nextIndex] - schedule[touchIndex];

  out.push({ json: {
    enrollmentId: row.enrollment_id,
    campaign: row.campaign,
    customer: row.full_name,
    touchNumber: nextIndex,
    sent: true,
    done: isLast,
    nextInDays: nextDays,
  } });
}

return out.length ? out : [{ json: { sent: false, note: 'nobody due today' } }];`),

    postgres('Advance Enrollment', `UPDATE nurture_enrollments SET
  touches_sent = touches_sent + 1,
  completed = {{ Boolean($json.done) }},
  next_touch_at = CASE
    WHEN {{ $json.nextInDays ? 'TRUE' : 'FALSE' }}
    THEN NOW() + ({{ $json.nextInDays || 0 }} || ' days')::interval
    ELSE next_touch_at
  END
WHERE id = '{{ $json.enrollmentId }}' AND {{ Boolean($json.sent) }};`,
      { alwaysOutputData: true }),
  ],

  connections: [
    ['Daily 10:00', 'Sweep Abandoned Reschedules'],
    ['Sweep Abandoned Reschedules', 'Enroll Abandoned'],
    ['Enroll Abandoned', 'Record Abandoned Enrollment'],
    ['Record Abandoned Enrollment', 'Find Due Touches'],
    ['Find Due Touches', 'Send Due Touches'],
    ['Send Due Touches', 'Advance Enrollment'],
  ],
});
