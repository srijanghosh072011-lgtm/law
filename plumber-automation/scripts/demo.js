#!/usr/bin/env node
'use strict';

/**
 * End-to-end demo — walks one booking through all 15 steps of the spec
 * against the mock vendors, printing a narrated timeline.
 *
 *   node scripts/demo.js                      the happy path
 *   node scripts/demo.js --decline            customer says no, then no again
 *   node scripts/demo.js --unclear            an ambiguous reply
 *   node scripts/demo.js --negative-feedback  the unhappy customer path
 *   node scripts/demo.js --no-consent         a booking that gets rejected
 *
 * Needs nothing running: no Docker, no database, no accounts. It boots the
 * mock vendor server in-process and calls the SAME lib/ modules the n8n Code
 * nodes call, so what you see here is the real logic, not a mock-up of it.
 *
 * What this does NOT exercise: n8n's own triggers, scheduling and retries.
 * For that, bring the stack up and import the workflows — see README.md.
 */

const path = require('node:path');

process.env.MOCK_MODE = 'true';
process.env.BUSINESS_NAME ||= 'Rapid Response Plumbing';
process.env.BUSINESS_PHONE ||= '+15125550100';
process.env.BUSINESS_EMAIL ||= 'dispatch@example-plumbing.com';
process.env.BUSINESS_TIMEZONE ||= 'America/Chicago';
process.env.QUIET_HOURS_START ||= '21';
process.env.QUIET_HOURS_END ||= '8';

const LIB = path.join(__dirname, '..', 'lib');
const { validateBooking, fullAddress } = require(`${LIB}/validation.js`);
const { scorePartners } = require(`${LIB}/partner-scoring.js`);
const { parseSmsReply } = require(`${LIB}/sms-parser.js`);
const { decideRoute } = require(`${LIB}/reply-routing.js`);
const { guardOutboundSms } = require(`${LIB}/compliance.js`);
const { buildRoute, savingsVersusBookedOrder } = require(`${LIB}/route-optimizer.js`);
const { classifyFeedback, discountCode } = require(`${LIB}/sentiment.js`);
const { once } = require(`${LIB}/idempotency.js`);
const { templates } = require(`${LIB}/templates.js`);
const { services } = require(`${LIB}/services.js`);

const mock = require('../mock/server.js');

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------
const ESC = '';
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColour ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const blue = (s) => c('36', s);

function step(specStep, title) {
  console.log('');
  console.log(bold(`${blue('>')} SPEC STEP ${specStep}  ${title}`));
  console.log(dim('  ' + '-'.repeat(66)));
}
const say = (msg) => console.log('  ' + msg);
const ok = (msg) => console.log('  ' + green('+') + ' ' + msg);
const warn = (msg) => console.log('  ' + yellow('!') + ' ' + msg);
const bad = (msg) => console.log('  ' + red('x') + ' ' + msg);

// ---------------------------------------------------------------------------
// A minimal in-memory stand-in for the jobs database, so the demo needs no
// Postgres. In production these reads and writes are n8n Postgres nodes.
// ---------------------------------------------------------------------------
function memoryDb() {
  const rows = new Map();
  return async function query(sql, params) {
    const head = sql.trim().split(/\s+/)[0].toUpperCase();
    if (head === 'INSERT') {
      const [key, jobId, stepName] = params;
      if (rows.has(key)) return { rows: [] };
      rows.set(key, { key, job_id: jobId, step: stepName, response: null });
      return { rows: [{ key }] };
    }
    if (head === 'SELECT') {
      const row = rows.get(params[0]);
      return { rows: row ? [{ response: row.response }] : [] };
    }
    if (head === 'UPDATE') {
      if (rows.has(params[0])) rows.get(params[0]).response = params[1];
      return { rows: [] };
    }
    if (head === 'DELETE') {
      const row = rows.get(params[0]);
      if (row && row.response === null) rows.delete(params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  };
}

// Same crew as db/seed.sql.
const PARTNERS = [
  { id: 'p-dave',  full_name: 'Dave Okafor',   phone: '+15125550111', email: 'dave@example-plumbing.com',
    base_lat: 30.2672, base_lng: -97.7431, service_radius_km: 35, max_jobs_per_day: 6, jobs_today: 2,
    skills: ['general_plumbing', 'drain', 'water_heater', 'emergency'], active: true },
  { id: 'p-maria', full_name: 'Maria Delgado', phone: '+15125550112', email: 'maria@example-plumbing.com',
    base_lat: 30.3505, base_lng: -97.7500, service_radius_km: 45, max_jobs_per_day: 5, jobs_today: 1,
    skills: ['general_plumbing', 'gas_line', 'water_heater', 'backflow_certified'], active: true },
  { id: 'p-sam',   full_name: 'Sam Whitfield', phone: '+15125550113', email: 'sam@example-plumbing.com',
    base_lat: 30.1900, base_lng: -97.8200, service_radius_km: 60, max_jobs_per_day: 4, jobs_today: 0,
    skills: ['general_plumbing', 'sewer', 'excavation', 'repipe'], active: true },
  { id: 'p-tia',   full_name: 'Tia Nguyen',    phone: '+15125550114', email: 'tia@example-plumbing.com',
    base_lat: 30.2900, base_lng: -97.6900, service_radius_km: 30, max_jobs_per_day: 7, jobs_today: 5,
    skills: ['general_plumbing', 'drain'], active: true },
  { id: 'p-rob',   full_name: 'Rob Castellan', phone: '+15125550115', email: 'rob@example-plumbing.com',
    base_lat: 30.2700, base_lng: -97.7400, service_radius_km: 40, max_jobs_per_day: 6, jobs_today: 0,
    skills: ['general_plumbing', 'water_heater', 'gas_line', 'sewer'], active: false },
];

// ---------------------------------------------------------------------------
async function main() {
  const args = new Set(process.argv.slice(2));
  const scenario = {
    decline: args.has('--decline'),
    unclear: args.has('--unclear'),
    negativeFeedback: args.has('--negative-feedback'),
    noConsent: args.has('--no-consent'),
  };

  // Boot the mock vendors on a free port.
  const port = 4300 + Math.floor(Math.random() * 300);
  process.env.MOCK_BASE_URL = `http://127.0.0.1:${port}`;
  await new Promise((resolve) => mock.server.listen(port, resolve));

  // The mock logs every call as "[001] twilio ..."; this script narrates
  // instead, so those lines are filtered out.
  const realLog = console.log;
  console.log = (...a) => {
    if (typeof a[0] === 'string' && /^\[\d{3}\]/.test(a[0])) return;
    realLog(...a);
  };

  const svc = services(process.env);
  const t = templates(process.env);
  const db = memoryDb();

  console.log('');
  console.log(bold('  PLUMBER BOOKING AUTOMATION - end-to-end demo'));
  console.log(dim(`  mock vendors on ${process.env.MOCK_BASE_URL} - nothing real is sent`));
  const active = Object.entries(scenario).filter(([, v]) => v).map(([k]) => k);
  console.log(dim(`  scenario: ${active.length ? active.join(', ') : 'happy path'}`));

  // =========================================================================
  step(1, 'Customer books on the website');

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const submission = {
    full_name: 'Dana Reyes',
    email: 'dana.reyes@example.com',
    phone: '(512) 555-9876',
    address_line: '4412 Red Oak Lane',
    city: 'Austin', state: 'TX', postal_code: '78745',
    job_type: 'water_heater',
    urgency: 'standard',
    description: 'No hot water since yesterday. Heater is about 11 years old and there is a small puddle underneath.',
    preferred_date: tomorrow,
    preferred_window: '08:00-12:00',
    sms_consent: !scenario.noConsent,
    sms_consent_source: 'booking_form_v1',
  };

  say(`form submitted: ${submission.full_name}, "${submission.job_type}", phone as typed "${submission.phone}"`);

  const validation = validateBooking(submission, process.env);
  if (!validation.ok) {
    bad('booking REJECTED:');
    validation.errors.forEach((e) => console.log('      - ' + e));
    say('');
    say(dim('The website form shows these to the customer. Nothing was created,'));
    say(dim('no partner was notified, and nobody was texted.'));
    return finish();
  }

  const { customer, job } = validation.value;
  ok(`validated - phone normalised to ${bold(customer.phone)} (Twilio rejects anything else)`);
  ok(`local ${submission.preferred_window} -> ${job.scheduled_start} UTC, DST-aware`);
  ok(`SMS consent recorded at ${customer.sms_consent_at}`);

  const coords = await svc.maps.geocode(fullAddress(customer));
  Object.assign(customer, coords);
  ok(`geocoded -> ${coords.lat}, ${coords.lng}`);

  job.id = 'job-' + Math.random().toString(16).slice(2, 10);
  customer.id = 'cust-' + Math.random().toString(16).slice(2, 10);

  // =========================================================================
  step(2, 'Push the customer into GoHighLevel');

  const contact = await svc.ghl.upsertContact(customer);
  ok(`contact ${bold(contact.id)}`);
  const opportunity = await svc.ghl.createOpportunity({
    contactId: contact.id,
    name: `${job.job_type.replace(/_/g, ' ')} - ${customer.full_name}`,
  });
  ok(`opportunity ${bold(opportunity.id)} on the pipeline`);
  await svc.ghl.tagContact(contact.id, ['booked-online', job.job_type, job.urgency]);
  ok('tagged: booked-online, water_heater, standard');

  // --- confirmations (still step 1) ---
  const confirmMail = t.bookingConfirmationEmail({ customer, job });
  await svc.email.send({ to: customer.email, subject: confirmMail.subject, html: confirmMail.html });
  ok(`confirmation email -> ${customer.email}`);

  const confirmSms = t.bookingConfirmationSms({ customer, job });
  await svc.twilio.sendSms({ to: customer.phone, body: confirmSms });
  ok(`confirmation SMS -> ${customer.phone}`);
  say(dim(`   "${confirmSms.slice(0, 88)}..."`));

  // =========================================================================
  step(3, 'Dispatch to the right partner');

  const ranking = scorePartners(
    { lat: customer.lat, lng: customer.lng, job_type: job.job_type, urgency: job.urgency },
    PARTNERS
  );

  if (!ranking.assigned) {
    warn('no partner qualified - the owner gets an alert instead of silence');
    ranking.rejected.forEach((r) => say(dim(`   ${r.partner.full_name}: ${r.reason}`)));
    return finish();
  }

  const partner = ranking.assigned.partner;
  ok(`assigned ${bold(partner.full_name)} (score ${ranking.assigned.score}, ${ranking.assigned.distanceKm}km away)`);
  ranking.assigned.reasons.forEach((r) => say(dim('   - ' + r)));
  if (ranking.rejected.length) {
    say(dim(`   ruled out: ${ranking.rejected.map((r) => `${r.partner.full_name} (${r.reason})`).join('; ')}`));
  }

  await svc.twilio.sendSms({
    to: partner.phone,
    body: t.partnerDispatchSms({ partner, customer, job }),
  });
  ok(`job texted to ${partner.full_name}`);

  // =========================================================================
  step(4, 'T-24: ask them to confirm');

  const t24 = t.t24ConfirmSms({ customer, job });
  const gate = guardOutboundSms(
    { template: 't24_confirm', body: t24, optedOut: false, consented: customer.sms_consent },
    process.env
  );

  if (gate.action === 'defer') {
    warn(`held: ${gate.reason} - will send at ${gate.deferUntil}`);
    say(dim('   Deferred, not dropped: a held reminder still works, a dropped one is a missed job.'));
  } else {
    await svc.twilio.sendSms({ to: customer.phone, body: t24 });
    ok(`confirmation SMS sent (${gate.cost.segments} segment, ${gate.cost.encoding})`);
  }
  say(dim(`   "${t24}"`));

  // =========================================================================
  const reply = scenario.decline ? "sorry, can't make it that day"
    : scenario.unclear ? 'yes but can we move it a bit later'
    : 'ya sounds good, see you then';

  step('4->7', 'The customer texts back');
  say(`they reply: ${bold('"' + reply + '"')}`);

  const parsed = parseSmsReply(reply);
  ok(`parsed as ${bold(parsed.intent)} (${parsed.confidence} confidence) - ${parsed.reason}`);

  const routed = decideRoute({ intent: parsed.intent, hasJob: true, declineCount: 0 });
  say(`routed to: ${bold(routed.route)} - ${routed.why}`);

  if (routed.route === 'UNCLEAR') {
    warn('NOT auto-resolved. A human is emailed and the appointment is untouched.');
    await svc.email.send({
      to: process.env.BUSINESS_EMAIL,
      subject: `Needs a human: unclear reply from ${customer.phone}`,
      text: `"${reply}" - ${parsed.reason}`,
    });
    ok('escalation email sent to the office');
    say('');
    say(dim('  This is the whole point of the design. A false YES sends a van to an'));
    say(dim('  empty house; a false NO cancels a job they wanted. UNCLEAR costs a glance.'));
    return finish();
  }

  if (routed.route === 'NO_FIRST') {
    step(5, 'First decline -> reschedule sequence');
    await svc.twilio.sendSms({ to: customer.phone, body: t.rescheduleSms() });
    const rm = t.rescheduleEmail({ customer });
    await svc.email.send({ to: customer.email, subject: rm.subject, html: rm.html });
    ok('slot released, booking link sent by SMS and email');
    await svc.ghl.tagContact(contact.id, ['rescheduling']);

    step(6, 'They decline again -> nurture');
    const secondReply = "no, don't need it anymore";
    say('they reply: ' + bold('"' + secondReply + '"'));
    const second = parseSmsReply(secondReply);
    const secondRoute = decideRoute({ intent: second.intent, hasJob: true, declineCount: 1 });
    ok(`parsed ${second.intent} -> ${bold(secondRoute.route)} - ${secondRoute.why}`);

    await svc.twilio.sendSms({ to: customer.phone, body: t.nurtureSms() });
    await svc.ghl.tagContact(contact.id, ['nurture', 'declined-twice']);
    await svc.ghl.enrollInCampaign(contact.id, 'declined_reactivation');
    ok('stopped chasing; enrolled in declined_reactivation (30 / 120 / 365 days)');
    say('');
    say(dim('  Chasing a third time is how a business earns spam complaints.'));
    return finish();
  }

  // ---- YES ----
  step(7, 'They confirmed');
  await svc.twilio.sendSms({ to: customer.phone, body: t.confirmedSms({ job }) });
  await svc.ghl.moveOpportunity(opportunity.id, 'confirmed');
  await svc.ghl.tagContact(contact.id, ['confirmed-appointment']);
  ok('locked in, CRM moved to Confirmed, customer told');
  say(dim('   (The original spec had this branch sending the booking link again -'));
  say(dim('    that was backwards. Yes means confirmed.)'));

  // =========================================================================
  step(8, "Build tomorrow's route");

  const otherJobs = [
    { job_id: 'j-north', customer_name: 'Marcus Hale',  lat: 30.4500, lng: -97.7500, scheduled_start: job.scheduled_start, service_minutes: 45 },
    { job_id: 'j-south', customer_name: 'Priya Anand',  lat: 30.1000, lng: -97.8000, scheduled_start: job.scheduled_start, service_minutes: 60 },
    { job_id: 'j-east',  customer_name: 'Owen Brady',   lat: 30.2900, lng: -97.7200, scheduled_start: job.scheduled_start, service_minutes: 45 },
    { job_id: 'j-pm',    customer_name: 'Lena Fischer', lat: 30.4400, lng: -97.7600,
      scheduled_start: new Date(new Date(job.scheduled_start).getTime() + 6 * 3600000).toISOString(), service_minutes: 90 },
  ];
  const allStops = [
    { job_id: job.id, customer_name: customer.full_name, lat: customer.lat, lng: customer.lng,
      scheduled_start: job.scheduled_start, service_minutes: 150 },
    ...otherJobs,
  ];

  const origin = { lat: partner.base_lat, lng: partner.base_lng };
  const built = buildRoute({ origin, stops: allStops, startTime: job.scheduled_start });
  const savings = savingsVersusBookedOrder({ origin, stops: allStops, optimisedStops: built.stops });

  ok(`${built.stops.length} stops ordered for ${partner.full_name}`);
  built.stops.forEach((s) => {
    const mine = s.job_id === job.id;
    const label = `${s.stop_order}. ${s.customer_name.padEnd(14)} eta ${new Date(s.eta).toISOString().slice(11, 16)}`;
    say(mine ? bold(label + '  <- our booking') : dim(label));
  });
  ok(`${built.totalDistanceKm}km, ~${built.totalDriveMinutes}min driving`);
  ok(`saved ${bold(savings.savedKm + 'km')} (${savings.savedPercent}%) versus driving them in booking order`);
  say(dim('   Promised windows are hard constraints - the afternoon job stayed in'));
  say(dim('   the afternoon even though it sits next to a morning stop.'));

  // =========================================================================
  step(9, 'On the way');

  const eta = await svc.maps.eta({ from: origin, destination: fullAddress(customer) });
  const omw = t.onMyWaySms({ customer, partnerName: partner.full_name, etaMinutes: eta.durationMinutes });
  await svc.twilio.sendSms({ to: customer.phone, body: omw });
  ok(`${partner.full_name} tapped "On my way" -> customer texted a ${eta.durationMinutes} min ETA`);
  say(dim(`   "${omw}"`));
  say(dim('   A tap plus a live ETA - not background GPS tracking. Do not sell it as tracking.'));

  // =========================================================================
  step(10, 'Claude writes the job report');

  const notes = 'Found the T&P valve seeping and heavy scale in the tank. Drained and '
    + 'flushed, fitted a new T&P valve and drain cock, pressure-tested at 80psi for '
    + '15 minutes with no further leaks. Restored supply, checked all fixtures. Tank '
    + 'is 11 years old and near end of life - worth budgeting for replacement.';

  const report = await svc.claude.generateReport({
    job, customer, partnerName: partner.full_name, notes,
    photoCaptions: ['T&P valve before', 'new valve fitted', 'pressure gauge at 80psi'],
  });
  ok(`report generated from the plumber's notes (${report.length} chars)`);
  report.split('\n').filter((l) => l.startsWith('## ')).forEach((h) => say(dim('   ' + h)));

  const reportMail = t.reportEmail({ customer, job, reportMarkdown: report });
  await svc.email.send({ to: customer.email, subject: reportMail.subject, html: reportMail.html });
  ok(`report emailed to ${customer.email}`);

  // =========================================================================
  step(11, 'Invoice via QuickBooks');

  const invoiceResult = await once(db, { jobId: job.id, step: 'quickbooks_invoice' }, async () => {
    const inv = await svc.quickbooks.createInvoice({
      customerRef: contact.id,
      customerEmail: customer.email,
      lines: [{ description: 'Water heater service - T&P valve replacement', amount: 245, qty: 1 }],
    });
    await svc.quickbooks.sendInvoice(inv.Id, customer.email);
    return inv;
  });
  ok(`invoice ${bold(invoiceResult.response.DocNumber)} for $${invoiceResult.response.TotalAmt.toFixed(2)}, emailed`);

  // Prove the guard: replay the step, exactly as an n8n retry would.
  const replay = await once(db, { jobId: job.id, step: 'quickbooks_invoice' }, async () => {
    throw new Error('this must never run');
  });
  if (!replay.skipped) throw new Error('IDEMPOTENCY BROKEN - the vendor was called twice');
  ok(`replayed the step (simulating an n8n retry) -> ${bold('skipped')}, no second invoice`);

  // =========================================================================
  step(12, 'Ask how it went');

  const fbMail = t.feedbackEmail({ customer, job, feedbackUrl: 'http://localhost:5678/webhook/feedback' });
  await svc.email.send({ to: customer.email, subject: fbMail.subject, html: fbMail.html });
  ok('feedback email sent with one-click 1-5 stars');

  // =========================================================================
  const feedback = scenario.negativeFeedback
    ? { rating: 2, text: 'He was two hours late and it is still dripping' }
    : { rating: 5, text: 'Fantastic, tidy and quick. Highly recommend.' };

  step('13/14', 'They answer');
  say(`they gave ${bold(feedback.rating + '/5')}: "${feedback.text}"`);

  const verdict = classifyFeedback(feedback);
  ok(`classified ${bold(verdict.sentiment)} (${verdict.confidence}, via ${verdict.source})`);

  if (verdict.actions.ownerCallback) {
    // ---- step 13 ----
    const title = t.ownerTaskTitle({ customer, rating: feedback.rating });
    await svc.email.send({
      to: process.env.BUSINESS_EMAIL,
      subject: 'CALL TODAY: ' + title,
      text: t.ownerTaskDetail({ customer, job, feedbackText: feedback.text }),
    });
    ok(`owner task created: "${title}" - due within 1 day`);

    const recovery = t.serviceRecoveryEmail({ customer });
    await svc.email.send({ to: customer.email, subject: recovery.subject, html: recovery.html });
    ok('recovery email sent to the customer');
    await svc.ghl.tagContact(contact.id, ['unhappy', 'needs-callback']);

    say('');
    say(red('   NO review request was sent.') + dim(' Asking an unhappy customer to review'));
    say(dim('   you on Google is asking them to publish the complaint.'));
    say(dim('   No discount either - that reads as buying silence.'));
  } else if (verdict.actions.reviewRequest) {
    // ---- step 14 ----
    const code = discountCode(customer.full_name, job.id);
    const ty = t.thankYouEmail({ customer, discountCode: code, discountPercent: 10 });
    await svc.email.send({ to: customer.email, subject: ty.subject, html: ty.html });
    ok(`thank-you sent with discount code ${bold(code)} and a Google review link`);
    await svc.ghl.tagContact(contact.id, ['happy', 'review-requested']);
  } else {
    warn('neutral - a quiet note to the owner, and deliberately no review request');
    say(dim('   A 3-star public review pulls the average down.'));
  }

  // =========================================================================
  step(15, 'Into the long game');

  await svc.ghl.enrollInCampaign(contact.id, 'post_job_maintenance');
  ok('enrolled in post_job_maintenance - touches at 90, 180 and 365 days');
  say(dim('   Happy or unhappy, everybody enters it. Email only: marketing texts'));
  say(dim("   are what destroy a number's sending reputation."));

  finish();
}

// ---------------------------------------------------------------------------
function finish() {
  const calls = mock.timeline;
  const byService = calls.reduce((acc, e) => {
    acc[e.service] = (acc[e.service] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log(dim('  ' + '='.repeat(68)));
  console.log(bold('  VENDOR CALLS MADE'));
  console.log('');
  for (const [service, count] of Object.entries(byService).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${service.padEnd(12)} ${String(count).padStart(2)}`);
  }
  console.log(dim(`    ${'total'.padEnd(12)} ${String(calls.length).padStart(2)}`));

  const sms = calls.filter((e) => e.action === 'sms.sent');
  const emails = calls.filter((e) => e.action === 'email.sent');
  console.log('');
  console.log(`  ${sms.length} SMS, ${emails.length} emails - all intercepted, none delivered anywhere real.`);
  console.log('');

  mock.server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('');
  console.error(red('  demo failed: ') + err.message);
  console.error(dim(String(err.stack).split('\n').slice(1, 4).join('\n')));
  try { mock.server.close(); } catch { /* already closed */ }
  process.exit(1);
});
