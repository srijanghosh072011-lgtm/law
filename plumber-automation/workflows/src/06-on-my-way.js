'use strict';

/**
 * Workflow 06 — On My Way.  Spec step 9.
 *
 * "Customers are automatically notified via SMS when the plumber is arriving."
 *
 * HOW THIS ACTUALLY WORKS, AND WHY:
 * True GPS proximity needs the plumber's phone broadcasting its location
 * continuously in the background — a driver app, battery drain, permission
 * prompts, and a per-driver subscription. Instead the plumber taps one button
 * as they leave the previous job (web/on-my-way.html), and we pull a live ETA
 * and text it to the customer.
 *
 * Same customer experience, no tracking infrastructure, works on day one.
 * Do not describe this to a client as "GPS tracking" — it isn't.
 *
 * Endpoint:  POST /webhook/on-my-way   { jobId, lat?, lng? }
 */

const { workflow, webhook, code, postgres, ifNode, respond, LIB } = require('./_builder.js');

module.exports = workflow({
  name: '06 · On My Way',
  tags: ['plumber'],
  notes: `## 06 · On My Way\n\n**Trigger:** the plumber taps "On my way" in \`web/on-my-way.html\`.\n\n**Does:** takes their current position, asks Google Maps for a live ETA to the next stop, and texts the customer.\n\nThis is NOT background GPS tracking — a tap plus a live ETA. Don't sell it as tracking.\n\nCovers spec step **9**.`,

  nodes: [
    webhook('On My Way Tapped', 'on-my-way'),

    code('Read Request', `${LIB}
const payload = $input.first().json.body ?? $input.first().json;
const jobId = payload.jobId || payload.job_id;
if (!jobId) throw new Error('on-my-way needs a jobId');

// The browser's geolocation, if the plumber allowed it. Falls back to the
// partner's base, which still gives a usable ETA.
const lat = Number(payload.lat);
const lng = Number(payload.lng);

return [{ json: {
  jobId,
  from: (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null,
} }];`),

    postgres('Load Stop & Customer', `SELECT
  j.id AS job_id, j.job_type, j.scheduled_start, j.status,
  c.full_name, c.phone, c.address_line, c.city, c.lat, c.lng, c.sms_consent,
  p.full_name AS partner_name, p.base_lat, p.base_lng,
  rs.on_my_way_at,
  (o.phone IS NOT NULL) AS opted_out
FROM jobs j
JOIN customers c ON c.id = j.customer_id
LEFT JOIN partners p ON p.id = j.partner_id
LEFT JOIN sms_optouts o ON o.phone = c.phone
LEFT JOIN route_stops rs ON rs.job_id = j.id AND rs.route_date = CURRENT_DATE
WHERE j.id = '{{ $json.jobId }}';`),

    // Tapping twice must not text the customer twice — easy to do with a
    // phone in a work glove.
    ifNode('Not Already Sent?', '!$json.on_my_way_at'),

    code('Compute ETA & Text Customer', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');
const { guardOutboundSms } = require(LIB + '/compliance.js');

const stop = $input.first().json;
const req = $('Read Request').first().json;
const { maps, twilio } = services(env);
const t = templates(env);

if (stop.lat == null || stop.lng == null) {
  return [{ json: { jobId: stop.job_id, sent: false, reason: 'customer address has no coordinates' } }];
}

const from = req.from || { lat: stop.base_lat, lng: stop.base_lng };

// An ETA lookup failing must not stop the customer being told the plumber is
// coming — fall back to a sensible default rather than sending nothing.
let etaMinutes = 20;
try {
  const eta = await maps.eta({
    from,
    destination: [stop.address_line, stop.city].filter(Boolean).join(', '),
  });
  if (eta && Number.isFinite(eta.durationMinutes)) etaMinutes = eta.durationMinutes;
} catch (err) {
  console.warn('ETA lookup failed, using default:', err.message);
}

const customer = { full_name: stop.full_name, address_line: stop.address_line };
const body = t.onMyWaySms({
  customer,
  partnerName: stop.partner_name || 'Your technician',
  etaMinutes,
});

// Transactional: the van is literally moving, so quiet hours do not apply.
// Opt-out still does.
const gate = guardOutboundSms({
  template: 'on_my_way', body, optedOut: stop.opted_out, consented: stop.sms_consent,
}, env);

if (!gate.allow) {
  return [{ json: { jobId: stop.job_id, sent: false, reason: gate.reason } }];
}

await twilio.sendSms({ to: stop.phone, body });

return [{ json: {
  jobId: stop.job_id, sent: true, etaMinutes,
  customer: stop.full_name, body,
} }];`),

    postgres('Mark En Route', `UPDATE route_stops SET on_my_way_at = NOW()
WHERE job_id = '{{ $json.jobId }}' AND route_date = CURRENT_DATE;

UPDATE jobs SET status = 'en_route'
WHERE id = '{{ $json.jobId }}' AND status IN ('routed', 'confirmed', 'unconfirmed');`),

    code('Already Sent', `return [{ json: {
  jobId: $input.first().json.job_id,
  sent: false,
  reason: 'the customer has already been told you are on the way',
} }];`),

    respond('Respond', {
      body: '={{ JSON.stringify($json) }}',
    }),
  ],

  connections: [
    ['On My Way Tapped', 'Read Request'],
    ['Read Request', 'Load Stop & Customer'],
    ['Load Stop & Customer', 'Not Already Sent?'],
    ['Not Already Sent?', 'Compute ETA & Text Customer', 0],
    ['Not Already Sent?', 'Already Sent', 1],
    ['Compute ETA & Text Customer', 'Mark En Route'],
    ['Mark En Route', 'Respond'],
    ['Already Sent', 'Respond'],
  ],
});
