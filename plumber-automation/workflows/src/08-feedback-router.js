'use strict';

/**
 * Workflow 08 — Feedback Router.  Spec steps 13, 14, 15.
 *
 *   negative -> a task for the owner to call, plus a recovery email      (13)
 *   positive -> thank-you, discount code, Google review link             (14)
 *   neutral  -> a quiet follow-up. No review request.
 *   everyone -> nurture / reactivation                                   (15)
 *
 * The review link is gated at 4+ stars. Sending it to an unhappy customer is
 * asking them to publish the complaint — see lib/sentiment.js.
 *
 * Endpoint:  GET|POST /webhook/feedback?job=<id>&rating=<1-5>
 */

const { workflow, webhook, code, postgres, switchNode, respond, LIB } = require('./_builder.js');

module.exports = workflow({
  name: '08 · Feedback Router',
  tags: ['plumber'],
  notes: `## 08 · Feedback Router\n\n**Trigger:** the customer clicks a star in the feedback email.\n\n**Branches:** negative → owner callback task + recovery email · neutral → quiet follow-up · positive → thank-you + discount + review link.\n\nThe review link is gated at 4+ stars. Everyone, whatever they said, enters nurture.\n\nCovers spec steps **13**, **14** and **15**.`,

  nodes: [
    webhook('Feedback Received', 'feedback', { method: 'GET' }),

    code('Classify Feedback', `${LIB}
const { classifyFeedback, modelPrompt, parseModelSentiment } = require(LIB + '/sentiment.js');
const { services } = require(LIB + '/services.js');

const q = $input.first().json.query ?? {};
const body = $input.first().json.body ?? {};

const jobId = q.job || body.job || body.jobId;
const rating = q.rating ?? body.rating;
const text = q.comment ?? body.comment ?? body.text ?? '';

if (!jobId) throw new Error('feedback needs a job id');

let result = classifyFeedback({ rating, text });

// Only spend a Claude call when the rating and keywords both came up empty.
if (result.needsModel) {
  try {
    const { claude } = services(env);
    const { request } = require(LIB + '/services.js');
    const { endpoints } = require(LIB + '/config.js');

    const res = await request(endpoints(env).anthropic + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY || 'mock-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: modelPrompt(text) }],
      }),
    });

    const word = parseModelSentiment(res.content.map(c => c.text).join(''));
    result = classifyFeedback({ rating: word === 'positive' ? 5 : word === 'negative' ? 2 : 3, text: '' });
    result.source = 'claude';
  } catch (err) {
    // A model failure must not lose the feedback. Neutral is the safe
    // landing: a human follow-up, and no review request.
    console.warn('sentiment model failed, defaulting to neutral:', err.message);
    result = classifyFeedback({ rating: 3 });
    result.source = 'model-failed-defaulted-neutral';
  }
}

return [{ json: {
  jobId,
  rating: rating != null ? Number(rating) : null,
  text,
  sentiment: result.sentiment,
  confidence: result.confidence,
  source: result.source,
  actions: result.actions,
} }];`),

    postgres('Save Feedback & Load Job', `UPDATE jobs SET
  feedback_rating = {{ $json.rating ?? 'NULL' }},
  feedback_text = {{ $json.text ? "'" + String($json.text).replace(/'/g, "''") + "'" : 'NULL' }},
  feedback_sentiment = '{{ $json.sentiment }}',
  status = 'closed'
WHERE id = '{{ $json.jobId }}';

SELECT
  j.id AS job_id, j.job_type, j.scheduled_start, j.feedback_rating, j.feedback_text,
  c.id AS customer_id, c.full_name, c.email, c.phone, c.address_line, c.ghl_contact_id
FROM jobs j
JOIN customers c ON c.id = j.customer_id
WHERE j.id = '{{ $json.jobId }}';`),

    code('Merge Context', `${LIB}
const classified = $('Classify Feedback').first().json;
const job = $input.first().json;
if (!job || !job.job_id) throw new Error('no job found for feedback on ' + classified.jobId);
return [{ json: { ...classified, job } }];`),

    switchNode('Route Sentiment', [
      { label: 'negative', condition: "$json.sentiment === 'negative'" },
      { label: 'positive', condition: "$json.sentiment === 'positive'" },
    ]),

    // ---------------- negative: get a human on the phone (step 13) -------
    code('Create Owner Task', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');

const ctx = $input.first().json;
const { email, ghl } = services(env);
const t = templates(env);

const customer = {
  full_name: ctx.job.full_name, phone: ctx.job.phone,
  address_line: ctx.job.address_line,
};
const job = { job_type: ctx.job.job_type, scheduled_start: ctx.job.scheduled_start };

const title = t.ownerTaskTitle({ customer, rating: ctx.rating ?? '?' });
const detail = t.ownerTaskDetail({ customer, job, feedbackText: ctx.text });

// The owner is told immediately — an unhappy plumbing customer who hears
// nothing for three days writes the one-star review anyway.
await email.send({
  to: env.BUSINESS_EMAIL || 'dispatch@example-plumbing.com',
  subject: 'CALL TODAY: ' + title,
  text: detail,
  html: '<pre style="font:14px ui-monospace,Menlo,monospace;white-space:pre-wrap;">' + detail + '</pre>',
});

// And the customer hears from us, without a discount — a discount reads as
// buying silence when what they want is the problem fixed.
const recovery = t.serviceRecoveryEmail({ customer });
await email.send({ to: ctx.job.email, subject: recovery.subject, html: recovery.html });

if (ctx.job.ghl_contact_id) {
  await ghl.tagContact(ctx.job.ghl_contact_id, ['unhappy', 'needs-callback']);
}

return [{ json: { jobId: ctx.job.job_id, customerId: ctx.job.customer_id, path: 'negative', title, detail } }];`),

    postgres('Save Owner Task', `INSERT INTO owner_tasks (job_id, title, detail, priority, due_at)
VALUES (
  '{{ $json.jobId }}',
  '{{ String($json.title).replace(/'/g, "''") }}',
  '{{ String($json.detail).replace(/'/g, "''") }}',
  'urgent',
  NOW() + INTERVAL '1 day'
);`),

    // ---------------- positive: thank, discount, review (step 14) --------
    code('Thank & Request Review', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');
const { discountCode } = require(LIB + '/sentiment.js');

const ctx = $input.first().json;
const { email, ghl } = services(env);
const t = templates(env);

const code = discountCode(ctx.job.full_name, ctx.job.job_id);
const mail = t.thankYouEmail({
  customer: { full_name: ctx.job.full_name },
  discountCode: code,
  discountPercent: 10,
});

await email.send({ to: ctx.job.email, subject: mail.subject, html: mail.html });

if (ctx.job.ghl_contact_id) {
  await ghl.tagContact(ctx.job.ghl_contact_id, ['happy', 'review-requested', code]);
}

return [{ json: {
  jobId: ctx.job.job_id, customerId: ctx.job.customer_id,
  path: 'positive', discountCode: code,
} }];`),

    // ---------------- neutral: quiet follow-up ---------------------------
    code('Quiet Follow Up', `${LIB}
const { services } = require(LIB + '/services.js');

const ctx = $input.first().json;
const { email, ghl } = services(env);

// A 3-star is a warning sign, not a crisis. No review link (it would drag
// the average down), no urgent call — just a note the owner can act on.
await email.send({
  to: env.BUSINESS_EMAIL || 'dispatch@example-plumbing.com',
  subject: 'Lukewarm feedback from ' + ctx.job.full_name,
  text: [
    ctx.job.full_name + ' rated the ' + ctx.job.job_type.replace(/_/g, ' ') + ' job ' + (ctx.rating ?? '?') + '/5.',
    ctx.text ? 'They said: "' + ctx.text + '"' : 'They left no comment.',
    '',
    'No review request was sent — a 3-star public review would pull the',
    'average down. Worth a call if you want to understand what was missing.',
  ].join('\\n'),
});

if (ctx.job.ghl_contact_id) {
  await ghl.tagContact(ctx.job.ghl_contact_id, ['neutral-feedback']);
}

return [{ json: { jobId: ctx.job.job_id, customerId: ctx.job.customer_id, path: 'neutral' } }];`),

    // ---------------- everyone: nurture (step 15) ------------------------
    code('Enroll in Maintenance Nurture', `${LIB}
const { services } = require(LIB + '/services.js');

const ctx = $input.first().json;
const { ghl } = services(env);

// Spec step 15: happy or unhappy, everybody enters the long-cycle campaign.
// Water heaters, drains and pipework all fail again eventually — this is
// what turns one job into a customer.
if (ctx.jobId) {
  const row = $('Merge Context').first().json;
  if (row.job.ghl_contact_id) {
    await ghl.enrollInCampaign(row.job.ghl_contact_id, 'post_job_maintenance');
  }
}

return [{ json: { ...ctx, nurtureEnrolled: true } }];`),

    postgres('Record Maintenance Enrollment', `INSERT INTO nurture_enrollments (customer_id, job_id, campaign, next_touch_at)
VALUES ('{{ $json.customerId }}', '{{ $json.jobId }}', 'post_job_maintenance', NOW() + INTERVAL '90 days')
ON CONFLICT (customer_id, campaign) DO UPDATE SET
  next_touch_at = EXCLUDED.next_touch_at,
  job_id = EXCLUDED.job_id,
  touches_sent = 0,
  completed = FALSE;`),

    respond('Thanks Page', {
      body: '={{ "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\\"width=device-width,initial-scale=1\\"><title>Thank you</title></head><body style=\\"font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f2f4f7;color:#14181f\\"><div style=\\"text-align:center;padding:32px\\"><h1 style=\\"font-size:22px;margin:0 0 8px\\">Thank you</h1><p style=\\"color:#5f6874;margin:0\\">Your feedback has been recorded.</p></div></body></html>" }}',
    }),
  ],

  connections: [
    ['Feedback Received', 'Classify Feedback'],
    ['Classify Feedback', 'Save Feedback & Load Job'],
    ['Save Feedback & Load Job', 'Merge Context'],
    ['Merge Context', 'Route Sentiment'],

    ['Route Sentiment', 'Create Owner Task', 0],
    ['Route Sentiment', 'Thank & Request Review', 1],
    ['Route Sentiment', 'Quiet Follow Up', 2],   // fallback: neutral/unknown

    ['Create Owner Task', 'Save Owner Task'],
    ['Save Owner Task', 'Enroll in Maintenance Nurture'],
    ['Thank & Request Review', 'Enroll in Maintenance Nurture'],
    ['Quiet Follow Up', 'Enroll in Maintenance Nurture'],

    ['Enroll in Maintenance Nurture', 'Record Maintenance Enrollment'],
    ['Record Maintenance Enrollment', 'Thanks Page'],
  ],
});
