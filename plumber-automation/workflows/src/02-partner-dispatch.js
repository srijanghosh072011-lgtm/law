'use strict';

/**
 * Workflow 02 — Partner Dispatch.  Spec step 3.
 *
 * "Send the job to the relevant partner based on the geographical location and
 * the skills and expertise required."
 *
 * Called by 01 after a booking lands. Also callable on its own to re-dispatch
 * a job whose partner fell through.
 */

const { workflow, code, postgres, ifNode, LIB, node } = require('./_builder.js');

module.exports = workflow({
  name: '02 · Partner Dispatch',
  tags: ['plumber'],
  notes: `## 02 · Partner Dispatch\n\n**Trigger:** called by *01 · Booking Intake* (or run manually with a jobId).\n\n**Does:** loads every partner with their job count for that day, ranks them on distance + skills + capacity (\`lib/partner-scoring.js\`), assigns the winner and texts them the job.\n\nIf nobody qualifies it alerts the owner instead of failing silently — that path matters more than the happy one.\n\nCovers spec step **3**.`,

  nodes: [
    node('When Called by Another Workflow', 'n8n-nodes-base.executeWorkflowTrigger', {
      inputSource: 'passthrough',
    }, { typeVersion: 1.1 }),

    code('Read Job Id', `${LIB}
const input = $input.first().json;

// Accept a jobId from the calling workflow, or from a manual run.
const jobId = input.jobId || input.job_id || (input.job && input.job.id);
if (!jobId) throw new Error('02 · Partner Dispatch needs a jobId');

return [{ json: { jobId } }];`),

    postgres('Load Job & Customer', `SELECT
  j.id            AS job_id,
  j.job_type,
  j.urgency,
  j.scheduled_start,
  j.timezone,
  j.status,
  c.id            AS customer_id,
  c.full_name,
  c.phone,
  c.email,
  c.address_line,
  c.city,
  c.lat,
  c.lng
FROM jobs j
JOIN customers c ON c.id = j.customer_id
WHERE j.id = '{{ $json.jobId }}';`),

    // jobs_today is what stops us stacking six jobs on one person: it counts
    // what that partner already has booked on the same calendar day.
    postgres('Load Partners With Load', `SELECT
  p.*,
  COALESCE(load.jobs_today, 0)::int AS jobs_today
FROM partners p
LEFT JOIN (
  SELECT partner_id, COUNT(*) AS jobs_today
  FROM jobs
  WHERE partner_id IS NOT NULL
    AND status NOT IN ('cancelled', 'nurture')
    AND (scheduled_start AT TIME ZONE '{{ $('Load Job & Customer').first().json.timezone }}')::date
        = (TIMESTAMPTZ '{{ $('Load Job & Customer').first().json.scheduled_start }}' AT TIME ZONE '{{ $('Load Job & Customer').first().json.timezone }}')::date
  GROUP BY partner_id
) load ON load.partner_id = p.id
WHERE p.active = TRUE;`),

    code('Score & Choose Partner', `${LIB}
const { scorePartners } = require(LIB + '/partner-scoring.js');

const job = $('Load Job & Customer').first().json;
const partners = $input.all().map(i => i.json).filter(p => p && p.id);

// No coordinates means geocoding failed upstream. Ranking on nulls would
// silently produce nonsense, so stop and flag it for a human instead.
if (job.lat == null || job.lng == null) {
  return [{ json: {
    ...job,
    assigned: null,
    unassignedReason: 'address could not be geocoded — check the address on this booking',
    ranked: [], rejected: [],
  } }];
}

const result = scorePartners(
  { lat: job.lat, lng: job.lng, job_type: job.job_type, urgency: job.urgency },
  partners
);

if (!result.assigned) {
  return [{ json: {
    ...job,
    assigned: null,
    unassignedReason: 'no partner passed the filters',
    ranked: [],
    rejected: result.rejected.map(r => ({ name: r.partner.full_name, reason: r.reason })),
  } }];
}

return [{ json: {
  ...job,
  assigned: result.assigned.partner,
  score: result.assigned.score,
  distanceKm: result.assigned.distanceKm,
  reasons: result.assigned.reasons,
  runnersUp: result.ranked.slice(1, 4).map(r => ({ name: r.partner.full_name, score: r.score })),
  rejected: result.rejected.map(r => ({ name: r.partner.full_name, reason: r.reason })),
} }];`),

    ifNode('Partner Found?', '$json.assigned !== null'),

    postgres('Assign Partner', `UPDATE jobs
SET partner_id = '{{ $json.assigned.id }}', status = 'assigned'
WHERE id = '{{ $json.job_id }}'
RETURNING *;`),

    code('Notify Partner', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');

const chosen = $('Score & Choose Partner').first().json;
const { twilio, email } = services(env);
const t = templates(env);

const customer = {
  full_name: chosen.full_name,
  phone: chosen.phone,
  address_line: chosen.address_line,
  city: chosen.city,
};
const job = {
  job_type: chosen.job_type,
  urgency: chosen.urgency,
  scheduled_start: chosen.scheduled_start,
};

await twilio.sendSms({
  to: chosen.assigned.phone,
  body: t.partnerDispatchSms({ partner: chosen.assigned, customer, job }),
});

return [{ json: {
  jobId: chosen.job_id,
  assignedTo: chosen.assigned.full_name,
  score: chosen.score,
  distanceKm: chosen.distanceKm,
  why: chosen.reasons,
  runnersUp: chosen.runnersUp,
} }];`),

    // The path that actually protects the client: an unassignable job must
    // reach a human the same day, not sit silently in the database.
    code('Alert Owner — Unassigned', `${LIB}
const { services } = require(LIB + '/services.js');
const job = $input.first().json;
const { email, twilio } = services(env);

const detail = [
  'A booking could not be automatically assigned.',
  '',
  'Customer: ' + job.full_name + ' (' + job.phone + ')',
  'Address:  ' + job.address_line + (job.city ? ', ' + job.city : ''),
  'Job:      ' + job.job_type + ' (' + job.urgency + ')',
  'When:     ' + job.scheduled_start,
  '',
  'Reason: ' + job.unassignedReason,
  '',
  job.rejected && job.rejected.length
    ? 'Partners considered:\\n' + job.rejected.map(r => '  - ' + r.name + ': ' + r.reason).join('\\n')
    : '',
  '',
  'This job needs assigning by hand.',
].join('\\n');

await email.send({
  to: env.BUSINESS_EMAIL || 'dispatch@example-plumbing.com',
  subject: 'ACTION NEEDED: unassigned job for ' + job.full_name,
  text: detail,
  html: '<pre style="font:14px ui-monospace,Menlo,monospace;white-space:pre-wrap;">' + detail + '</pre>',
});

if (job.urgency === 'emergency') {
  await twilio.sendSms({
    to: env.BUSINESS_PHONE,
    body: 'URGENT: emergency job for ' + job.full_name + ' could not be auto-assigned. Check email.',
  });
}

return [{ json: { jobId: job.job_id, assigned: false, reason: job.unassignedReason } }];`),

    postgres('Flag Needs Attention', `UPDATE jobs SET status = 'needs_assignment'
WHERE id = '{{ $json.jobId }}';`),
  ],

  connections: [
    ['When Called by Another Workflow', 'Read Job Id'],
    ['Read Job Id', 'Load Job & Customer'],
    ['Load Job & Customer', 'Load Partners With Load'],
    ['Load Partners With Load', 'Score & Choose Partner'],
    ['Score & Choose Partner', 'Partner Found?'],
    ['Partner Found?', 'Assign Partner', 0],
    ['Partner Found?', 'Alert Owner — Unassigned', 1],
    ['Assign Partner', 'Notify Partner'],
    ['Alert Owner — Unassigned', 'Flag Needs Attention'],
  ],
});
