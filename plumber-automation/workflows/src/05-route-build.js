'use strict';

/**
 * Workflow 05 — Build Tomorrow's Route.  Spec step 8.
 *
 * "Add their location and time to the plumber's GPS route for tomorrow,
 * optimized to have the most efficient route."
 *
 * Runs each evening. Takes every confirmed job for tomorrow, groups them by
 * the arrival window the customer was promised, orders each group to minimise
 * driving, writes the result to route_stops, and emails the plumber their day
 * with a Google Maps link they can open on their phone.
 */

const { workflow, schedule, code, postgres, LIB } = require('./_builder.js');

module.exports = workflow({
  name: '05 · Build Tomorrow Route',
  tags: ['plumber'],
  notes: `## 05 · Build Tomorrow Route\n\n**Trigger:** nightly at 18:00 (also runnable by hand).\n\n**Does:** every confirmed job for tomorrow, per partner → grouped by promised window → driving minimised inside each window → saved to \`route_stops\` → emailed to the plumber with a Google Maps link.\n\nPromised windows are hard constraints: a convenient afternoon job is never pulled into the morning.\n\nCovers spec step **8**.`,

  nodes: [
    schedule('Every Evening 18:00', '0 18 * * *'),

    postgres('Load Tomorrow Confirmed Jobs', `SELECT
  j.id AS job_id, j.job_type, j.scheduled_start, j.timezone, j.urgency,
  p.id AS partner_id, p.full_name AS partner_name, p.email AS partner_email,
  p.phone AS partner_phone, p.base_lat, p.base_lng,
  c.id AS customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
  c.address_line, c.city, c.lat, c.lng,
  CASE j.job_type
    WHEN 'drain_cleaning'   THEN 45
    WHEN 'leak_repair'      THEN 60
    WHEN 'water_heater'     THEN 150
    WHEN 'tankless_install' THEN 300
    WHEN 'sewer_line'       THEN 300
    WHEN 'repipe'           THEN 480
    WHEN 'backflow_test'    THEN 30
    ELSE 60
  END AS service_minutes
FROM jobs j
JOIN partners p  ON p.id = j.partner_id
JOIN customers c ON c.id = j.customer_id
WHERE j.status IN ('confirmed', 'unconfirmed')
  AND (j.scheduled_start AT TIME ZONE j.timezone)::date
      = ((NOW() AT TIME ZONE '{{ $env.BUSINESS_TIMEZONE || 'America/Chicago' }}')::date + 1)
ORDER BY p.id, j.scheduled_start;`),

    code('Optimise Each Partner Route', `${LIB}
const { buildRoute, savingsVersusBookedOrder } = require(LIB + '/route-optimizer.js');

const rows = $input.all().map(i => i.json).filter(r => r && r.job_id);
if (!rows.length) return [{ json: { routes: [], note: 'no confirmed jobs tomorrow' } }];

// One route per partner — they each drive their own day.
const byPartner = new Map();
for (const row of rows) {
  if (!byPartner.has(row.partner_id)) byPartner.set(row.partner_id, []);
  byPartner.get(row.partner_id).push(row);
}

const out = [];

for (const [partnerId, jobs] of byPartner) {
  const first = jobs[0];
  const origin = { lat: first.base_lat, lng: first.base_lng };

  // Leave base 30 minutes before the earliest promised window.
  const earliest = Math.min(...jobs.map(j => new Date(j.scheduled_start).getTime()));
  const startTime = new Date(earliest - 30 * 60000).toISOString();

  const route = buildRoute({ origin, stops: jobs, startTime });
  const savings = savingsVersusBookedOrder({ origin, stops: jobs, optimisedStops: route.stops });

  out.push({ json: {
    partnerId,
    partnerName: first.partner_name,
    partnerEmail: first.partner_email,
    origin,
    stops: route.stops,
    skipped: route.skipped,
    totalDistanceKm: route.totalDistanceKm,
    totalDriveMinutes: route.totalDriveMinutes,
    savings,
  } }];
}

return out;`),

    // Rebuild the day from scratch rather than patching it: a job confirmed
    // late, cancelled, or reassigned changes the optimal order of everything
    // else, so a partial update would leave a stale sequence.
    postgres('Clear & Save Route Stops', `DELETE FROM route_stops
WHERE partner_id = '{{ $json.partnerId }}'
  AND route_date = (CURRENT_DATE + 1);

INSERT INTO route_stops (job_id, partner_id, route_date, stop_order, eta, drive_seconds, distance_meters)
SELECT
  (s->>'job_id')::uuid,
  '{{ $json.partnerId }}'::uuid,
  (CURRENT_DATE + 1),
  (s->>'stop_order')::int,
  (s->>'eta')::timestamptz,
  (s->>'drive_seconds')::int,
  (s->>'distance_meters')::int
FROM jsonb_array_elements({{ JSON.stringify(JSON.stringify($json.stops)) }}::jsonb) AS s;

UPDATE jobs SET status = 'routed'
WHERE id IN (
  SELECT (s->>'job_id')::uuid
  FROM jsonb_array_elements({{ JSON.stringify(JSON.stringify($json.stops)) }}::jsonb) AS s
) AND status = 'confirmed';`),

    code('Email Route to Plumber', `${LIB}
const { services } = require(LIB + '/services.js');
const { templates } = require(LIB + '/templates.js');

const route = $('Optimise Each Partner Route').first().json;
if (!route.stops || !route.stops.length) return [{ json: { emailed: false } }];

const { email } = services(env);
const t = templates(env);
const tz = env.BUSINESS_TIMEZONE || 'America/Chicago';

const rows = route.stops.map(s => \`
  <tr>
    <td style="padding:10px 8px;border-bottom:1px solid #e6e8eb;font-weight:700;">\${s.stop_order}</td>
    <td style="padding:10px 8px;border-bottom:1px solid #e6e8eb;">
      <strong>\${t.helpers.when(s.eta, tz, { weekday: undefined })}</strong><br>
      <span style="color:#5b6472;">\${s.customer_name} — \${s.job_type.replace(/_/g,' ')}</span>
    </td>
    <td style="padding:10px 8px;border-bottom:1px solid #e6e8eb;">
      \${s.address_line}\${s.city ? ', ' + s.city : ''}<br>
      <span style="color:#5b6472;font-size:12px;">\${s.customer_phone} · \${Math.round(s.drive_seconds/60)} min drive</span>
    </td>
  </tr>\`).join('');

// One tap opens the whole day in Google Maps, in order.
const mapsUrl = 'https://www.google.com/maps/dir/' +
  [route.origin, ...route.stops, route.origin]
    .map(p => (p.lat + ',' + p.lng))
    .join('/');

const skippedWarning = route.skipped && route.skipped.length
  ? '<p style="color:#b42318;"><strong>' + route.skipped.length + ' job(s) could not be placed</strong> — their address did not geocode. Check them by hand.</p>'
  : '';

await email.send({
  to: route.partnerEmail,
  subject: 'Your route for tomorrow — ' + route.stops.length + ' stops',
  html: \`<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;">
    <h2 style="margin:0 0 4px;">Tomorrow: \${route.stops.length} stops</h2>
    <p style="color:#5b6472;margin:0 0 18px;">
      \${route.totalDistanceKm} km · about \${route.totalDriveMinutes} min driving.
      Optimising saved \${route.savings.savedKm} km (\${route.savings.savedPercent}%) versus driving them in booking order.
    </p>
    \${skippedWarning}
    <p><a href="\${mapsUrl}" style="background:#1a56db;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">Open the whole route in Google Maps</a></p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:18px;">\${rows}</table>
    <p style="color:#5b6472;font-size:13px;margin-top:20px;">
      Tap "On my way" on each job as you leave the previous one and the customer gets an automatic ETA text.
    </p>
  </div>\`,
});

return [{ json: {
  emailed: true,
  partner: route.partnerName,
  stops: route.stops.length,
  savedKm: route.savings.savedKm,
  savedPercent: route.savings.savedPercent,
} }];`),
  ],

  connections: [
    ['Every Evening 18:00', 'Load Tomorrow Confirmed Jobs'],
    ['Load Tomorrow Confirmed Jobs', 'Optimise Each Partner Route'],
    ['Optimise Each Partner Route', 'Clear & Save Route Stops'],
    ['Clear & Save Route Stops', 'Email Route to Plumber'],
  ],
});
