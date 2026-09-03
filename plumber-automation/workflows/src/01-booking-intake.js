'use strict';

/**
 * Workflow 01 — Booking Intake.  Spec steps 1 and 2.
 *
 * Customer submits the booking form on the plumber's website. We validate it,
 * geocode the address, store customer + job, push the contact into
 * GoHighLevel, send the confirmation email and SMS, then hand off to dispatch.
 *
 * Public endpoint:  POST http://localhost:5678/webhook/booking
 */

const { workflow, webhook, code, postgres, ifNode, respond, executeWorkflow, LIB } = require('./_builder.js');

module.exports = workflow({
  name: '01 · Booking Intake',
  tags: ['plumber'],
  notes: `## 01 · Booking Intake\n\n**Trigger:** the website booking form POSTs here.\n\n**Does:** validate → geocode → save customer + job → create the GoHighLevel contact and opportunity → send confirmation email + SMS → hand off to *02 · Partner Dispatch*.\n\nA bad payload returns 400 with a list of what to fix, so the website form can show the customer.\n\nCovers spec steps **1** and **2**.`,

  nodes: [
    webhook('Booking Form Webhook', 'booking'),

    code('Validate & Normalise', `${LIB}
const { validateBooking, fullAddress } = require(LIB + '/validation.js');

// The webhook body arrives under .body. Support a bare body too, so you can
// test this node with "Execute Node" and pasted JSON.
const payload = $input.first().json.body ?? $input.first().json;

const result = validateBooking(payload, env);

if (!result.ok) {
  // Not an error — a 400. Returning data (rather than throwing) lets the
  // branch below answer the website politely instead of the execution dying.
  return [{ json: { ok: false, statusCode: 400, errors: result.errors } }];
}

return [{ json: {
  ok: true,
  customer: result.value.customer,
  job: result.value.job,
  geocodeAddress: fullAddress(result.value.customer),
} }];`),

    ifNode('Valid Booking?', '$json.ok'),

    respond('Reject 400', {
      statusCode: 400,
      body: '={{ JSON.stringify({ ok: false, errors: $json.errors }) }}',
    }),

    code('Geocode Address', `${LIB}
const { services } = require(LIB + '/services.js');
const { maps } = services(env);

const item = $input.first().json;

// Geocoding failure must not lose the booking — the job is still valid, it
// just can't be routed until someone fixes the address. Dispatch handles the
// null coordinates case.
let coords = { lat: null, lng: null };
try {
  const found = await maps.geocode(item.geocodeAddress);
  coords = { lat: found.lat, lng: found.lng };
} catch (err) {
  console.warn('geocode failed for "' + item.geocodeAddress + '":', err.message);
}

return [{ json: { ...item, customer: { ...item.customer, ...coords } } }];`),

    postgres('Upsert Customer', `INSERT INTO customers (
  full_name, email, phone, address_line, city, state, postal_code,
  lat, lng, sms_consent, sms_consent_at, sms_consent_source
) VALUES (
  '{{ $json.customer.full_name.replace(/'/g, "''") }}',
  '{{ $json.customer.email }}',
  '{{ $json.customer.phone }}',
  '{{ $json.customer.address_line.replace(/'/g, "''") }}',
  {{ $json.customer.city ? "'" + $json.customer.city.replace(/'/g, "''") + "'" : 'NULL' }},
  {{ $json.customer.state ? "'" + $json.customer.state + "'" : 'NULL' }},
  {{ $json.customer.postal_code ? "'" + $json.customer.postal_code + "'" : 'NULL' }},
  {{ $json.customer.lat ?? 'NULL' }},
  {{ $json.customer.lng ?? 'NULL' }},
  TRUE, NOW(), '{{ $json.customer.sms_consent_source }}'
)
ON CONFLICT (ghl_contact_id) DO NOTHING
RETURNING *;`),

    // A repeat customer already exists. The INSERT above only conflicts on
    // ghl_contact_id, so look up by phone to catch the real duplicate case.
    code('Resolve Customer Row', `${LIB}
const inserted = $input.first().json;
const booking = $('Geocode Address').first().json;

if (inserted && inserted.id) {
  return [{ json: { ...booking, customerRow: inserted } }];
}
return [{ json: { ...booking, customerRow: null } }];`),

    postgres('Find Existing Customer', `SELECT * FROM customers
WHERE phone = '{{ $json.customer.phone }}'
ORDER BY created_at DESC
LIMIT 1;`),

    code('Merge Customer', `${LIB}
const booking = $('Geocode Address').first().json;
const fromInsert = $('Resolve Customer Row').first().json.customerRow;
const fromLookup = $input.first().json;

const customerRow = fromInsert || (fromLookup && fromLookup.id ? fromLookup : null);
if (!customerRow) {
  throw new Error('could not create or find the customer record');
}

return [{ json: { ...booking, customerId: customerRow.id, customerRow } }];`),

    postgres('Insert Job', `INSERT INTO jobs (
  customer_id, job_type, description, urgency,
  scheduled_start, scheduled_end, timezone, status
) VALUES (
  '{{ $json.customerId }}',
  '{{ $json.job.job_type }}',
  {{ $json.job.description ? "'" + $json.job.description.replace(/'/g, "''") + "'" : 'NULL' }},
  '{{ $json.job.urgency }}',
  '{{ $json.job.scheduled_start }}',
  '{{ $json.job.scheduled_end }}',
  '{{ $json.job.timezone }}',
  'booked'
)
RETURNING *;`),

    // Spec step 2 (CRM) and step 1 (confirmations), together in one node so a
    // single idempotency claim covers the whole "welcome" bundle.
    code('CRM + Confirmations', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');

const jobRow = $input.first().json;
const booking = $('Merge Customer').first().json;
const customer = { ...booking.customerRow, ...booking.customer };
const job = { ...jobRow, ...booking.job, id: jobRow.id };

const { ghl, twilio, email } = services(env);
const t = templates(env);

// --- Step 2: into the CRM ---
const contact = await ghl.upsertContact(customer);
const opportunity = await ghl.createOpportunity({
  contactId: contact.id,
  name: job.job_type.replace(/_/g, ' ') + ' — ' + customer.full_name,
  stageId: env.GHL_STAGE_BOOKED_ID,
});
await ghl.tagContact(contact.id, ['booked-online', job.job_type, job.urgency]);

// --- Step 1: confirm to the customer ---
const mail = t.bookingConfirmationEmail({ customer, job });
await email.send({ to: customer.email, subject: mail.subject, html: mail.html });
await twilio.sendSms({ to: customer.phone, body: t.bookingConfirmationSms({ customer, job }) });

return [{ json: {
  jobId: job.id,
  customerId: customer.id,
  ghlContactId: contact.id,
  ghlOpportunityId: opportunity.id,
  job, customer,
} }];`),

    postgres('Save CRM Ids', `UPDATE jobs SET ghl_opportunity_id = '{{ $json.ghlOpportunityId }}'
WHERE id = '{{ $json.jobId }}';
UPDATE customers SET ghl_contact_id = '{{ $json.ghlContactId }}'
WHERE id = '{{ $json.customerId }}';`),

    executeWorkflow('Dispatch to Partner', '02 · Partner Dispatch'),

    respond('Respond 201', {
      body: '={{ JSON.stringify({ ok: true, jobId: $(\'CRM + Confirmations\').first().json.jobId }) }}',
    }),
  ],

  connections: [
    ['Booking Form Webhook', 'Validate & Normalise'],
    ['Validate & Normalise', 'Valid Booking?'],
    ['Valid Booking?', 'Geocode Address', 0],   // true
    ['Valid Booking?', 'Reject 400', 1],        // false
    ['Geocode Address', 'Upsert Customer'],
    ['Upsert Customer', 'Resolve Customer Row'],
    ['Resolve Customer Row', 'Find Existing Customer'],
    ['Find Existing Customer', 'Merge Customer'],
    ['Merge Customer', 'Insert Job'],
    ['Insert Job', 'CRM + Confirmations'],
    ['CRM + Confirmations', 'Save CRM Ids'],
    ['Save CRM Ids', 'Dispatch to Partner'],
    ['Dispatch to Partner', 'Respond 201'],
  ],
});
