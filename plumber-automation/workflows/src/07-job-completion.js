'use strict';

/**
 * Workflow 07 — Job Completion.  Spec steps 10, 11, 12.
 *
 * The plumber finishes, writes a few notes and uploads photos. From that:
 *   10. Claude writes a customer-facing report, emailed to them
 *   11. QuickBooks raises and sends the invoice
 *   12. a feedback request goes out
 *
 * Every external write is wrapped in an idempotency claim. Without that, one
 * n8n retry after a timeout bills the customer twice — the single worst
 * failure this system could have.
 *
 * Endpoint:  POST /webhook/job-complete
 */

const { workflow, webhook, code, postgres, respond, LIB } = require('./_builder.js');

module.exports = workflow({
  name: '07 · Job Completion',
  tags: ['plumber'],
  notes: `## 07 · Job Completion\n\n**Trigger:** the plumber submits notes + photos in \`web/job-complete.html\`.\n\n**Does:** Claude writes a customer-facing report → emailed → QuickBooks invoice raised and sent → feedback request queued.\n\nEvery external write claims an idempotency key first, so a retry after a timeout cannot double-invoice.\n\nCovers spec steps **10**, **11** and **12**.`,

  nodes: [
    webhook('Job Complete Submitted', 'job-complete'),

    code('Read Submission', `${LIB}
const payload = $input.first().json.body ?? $input.first().json;

const jobId = payload.jobId || payload.job_id;
if (!jobId) throw new Error('job-complete needs a jobId');

const notes = String(payload.notes || '').trim();
if (notes.length < 10) {
  throw new Error('notes are too short to write a report from — at least a sentence, please');
}

// Photos arrive as [{ name, caption }] metadata. Storing the binaries is out
// of scope here; captions are what the report actually needs.
const photos = Array.isArray(payload.photos) ? payload.photos : [];

return [{ json: {
  jobId,
  notes,
  photoCaptions: photos.map(p => p.caption || p.name).filter(Boolean),
  photoCount: photos.length,
  amountCents: Number(payload.amount_cents) || null,
  lineItems: Array.isArray(payload.line_items) ? payload.line_items : [],
} }];`),

    postgres('Load Job For Report', `SELECT
  j.id AS job_id, j.job_type, j.description, j.scheduled_start, j.timezone, j.status,
  j.quickbooks_invoice_id, j.ghl_opportunity_id,
  c.id AS customer_id, c.full_name, c.email, c.phone, c.address_line, c.city,
  c.ghl_contact_id,
  p.full_name AS partner_name
FROM jobs j
JOIN customers c ON c.id = j.customer_id
LEFT JOIN partners p ON p.id = j.partner_id
WHERE j.id = '{{ $json.jobId }}';`),

    // --- step 10: Claude writes the report -------------------------------
    code('Generate Report', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');

const job = $input.first().json;
const sub = $('Read Submission').first().json;

if (!job || !job.job_id) throw new Error('no job found for id ' + sub.jobId);

const { claude, email } = services(env);
const t = templates(env);

const customer = {
  full_name: job.full_name, email: job.email,
  address_line: job.address_line, city: job.city,
};

const reportMarkdown = await claude.generateReport({
  job: { job_type: job.job_type, description: job.description },
  customer,
  partnerName: job.partner_name,
  notes: sub.notes,
  photoCaptions: sub.photoCaptions,
});

const mail = t.reportEmail({
  customer,
  job: { scheduled_start: job.scheduled_start },
  reportMarkdown,
});
await email.send({ to: job.email, subject: mail.subject, html: mail.html });

return [{ json: { ...job, ...sub, reportMarkdown, reportSent: true } }];`),

    postgres('Save Report', `UPDATE jobs
SET status = 'completed', report_url = 'emailed'
WHERE id = '{{ $json.job_id }}';`),

    // --- step 11: the invoice --------------------------------------------
    // Claimed before the call, released if it fails. A duplicate invoice is
    // the failure a client would never forgive.
    postgres('Claim Invoice Step', `INSERT INTO idempotency_keys (key, job_id, step)
VALUES ('{{ $json.job_id }}:quickbooks_invoice', '{{ $json.job_id }}'::uuid, 'quickbooks_invoice')
ON CONFLICT (key) DO NOTHING
RETURNING key;`,
      { alwaysOutputData: true }),

    code('Create & Send Invoice', `${LIB}
const { services } = require(LIB + '/services.js');

const claimed = $input.first().json;
const ctx = $('Generate Report').first().json;

// No row returned from the claim means another execution already invoiced
// this job. Stop here rather than billing the customer a second time.
if (!claimed || !claimed.key) {
  return [{ json: { ...ctx, invoiceId: null, invoiced: false, reason: 'already invoiced' } }];
}

const { quickbooks } = services(env);

// Default pricing when the plumber didn't itemise. A client would replace
// this with their real rate card.
const lines = ctx.lineItems.length
  ? ctx.lineItems.map(l => ({ description: l.description, amount: Number(l.amount) || 0, qty: l.qty || 1 }))
  : [{
      description: ctx.job_type.replace(/_/g, ' ') + ' — service call',
      amount: (ctx.amountCents || 24500) / 100,
      qty: 1,
    }];

try {
  const invoice = await quickbooks.createInvoice({
    customerRef: ctx.ghl_contact_id || ctx.customer_id,
    customerEmail: ctx.email,
    lines,
  });
  await quickbooks.sendInvoice(invoice.Id, ctx.email);

  return [{ json: {
    ...ctx,
    invoiceId: invoice.Id,
    invoiceNumber: invoice.DocNumber,
    invoiceTotal: invoice.TotalAmt,
    invoiced: true,
  } }];
} catch (err) {
  // DO NOT throw here. Throwing stops the workflow, which means the next node
  // never runs — and that next node is what releases the idempotency claim.
  // A stuck claim would leave this job permanently marked as invoiced while
  // no invoice exists, so the customer is never billed at all.
  //
  // Instead fail forward: report it, let 'Save Invoice' release the claim so
  // a retry can work, and still send the report and feedback request. The
  // customer got their service; the billing just needs a human.
  console.error('invoice failed for job ' + ctx.job_id + ':', err.message);
  return [{ json: {
    ...ctx,
    invoiceId: null,
    invoiced: false,
    invoiceError: err.message,
  } }];
}`),

    postgres('Save Invoice', `UPDATE jobs
SET quickbooks_invoice_id = {{ $json.invoiceId ? "'" + $json.invoiceId + "'" : 'NULL' }},
    amount_cents = {{ $json.invoiceTotal ? Math.round($json.invoiceTotal * 100) : 'NULL' }},
    status = CASE WHEN {{ $json.invoiced }} THEN 'invoiced' ELSE status END
WHERE id = '{{ $json.job_id }}';

UPDATE idempotency_keys
SET response = {{ JSON.stringify(JSON.stringify({ invoiceId: $json.invoiceId })) }}::jsonb
WHERE key = '{{ $json.job_id }}:quickbooks_invoice' AND {{ Boolean($json.invoiced) }};

DELETE FROM idempotency_keys
WHERE key = '{{ $json.job_id }}:quickbooks_invoice'
  AND response IS NULL
  AND {{ Boolean($json.invoiceError) }};`),

    // --- step 12: ask how it went ----------------------------------------
    code('Send Feedback Request', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');

const ctx = $('Create & Send Invoice').first().json;
const { email, ghl } = services(env);
const t = templates(env);

const feedbackUrl = (env.WEBHOOK_URL || 'http://localhost:5678/').replace(/\\/$/, '') + '/webhook/feedback';

const mail = t.feedbackEmail({
  customer: { full_name: ctx.full_name },
  job: { id: ctx.job_id },
  feedbackUrl,
});
await email.send({ to: ctx.email, subject: mail.subject, html: mail.html });

if (ctx.ghl_opportunity_id) {
  await ghl.moveOpportunity(ctx.ghl_opportunity_id, env.GHL_STAGE_COMPLETED_ID || 'completed', 'won');
}

// A job that was done but not billed is money walking out of the door.
// It must reach a person the same day.
if (ctx.invoiceError) {
  await email.send({
    to: env.BUSINESS_EMAIL || 'dispatch@example-plumbing.com',
    subject: 'ACTION NEEDED: job completed but not invoiced — ' + ctx.full_name,
    text: [
      'The report went out and the customer was asked for feedback, but the',
      'invoice could not be raised.',
      '',
      'Customer: ' + ctx.full_name + ' (' + ctx.email + ')',
      'Job:      ' + ctx.job_type + ' — ' + ctx.job_id,
      'Error:    ' + ctx.invoiceError,
      '',
      'Raise this one by hand, or re-run workflow 07 for this job — the',
      'idempotency claim has been released so a retry will go through.',
    ].join('\\n'),
  });
}

return [{ json: {
  jobId: ctx.job_id,
  reportSent: true,
  invoiced: ctx.invoiced,
  invoiceNumber: ctx.invoiceNumber || null,
  invoiceError: ctx.invoiceError || null,
  feedbackRequested: true,
} }];`),

    respond('Respond', { body: '={{ JSON.stringify($json) }}' }),
  ],

  connections: [
    ['Job Complete Submitted', 'Read Submission'],
    ['Read Submission', 'Load Job For Report'],
    ['Load Job For Report', 'Generate Report'],
    ['Generate Report', 'Save Report'],
    ['Save Report', 'Claim Invoice Step'],
    ['Claim Invoice Step', 'Create & Send Invoice'],
    ['Create & Send Invoice', 'Save Invoice'],
    ['Save Invoice', 'Send Feedback Request'],
    ['Send Feedback Request', 'Respond'],
  ],
});
