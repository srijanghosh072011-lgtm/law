'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scorePartners,
  haversineKm,
  requiredSkillsFor,
} = require('../lib/partner-scoring.js');

// Job site: central Austin.
const JOB_SITE = { lat: 30.2672, lng: -97.7431 };

const partner = (over = {}) => ({
  id: 'p-default',
  full_name: 'Default',
  base_lat: 30.2672,
  base_lng: -97.7431,
  service_radius_km: 40,
  skills: ['general_plumbing'],
  max_jobs_per_day: 6,
  jobs_today: 0,
  active: true,
  ...over,
});

test('haversine matches a known real-world distance', () => {
  // Austin -> Round Rock is ~29km as the crow flies.
  const km = haversineKm(30.2672, -97.7431, 30.5083, -97.6789);
  assert.ok(km > 26 && km < 32, `expected ~29km, got ${km}`);
});

test('haversine is zero for the same point', () => {
  assert.equal(haversineKm(30.2672, -97.7431, 30.2672, -97.7431), 0);
});

test('job types map to their required skills', () => {
  assert.deepEqual(requiredSkillsFor('gas_line'), ['gas_line']);
  assert.deepEqual(requiredSkillsFor('tankless_install'), [
    'general_plumbing',
    'water_heater',
    'gas_line',
  ]);
  // Unknown types must not crash dispatch — fall back to general plumbing.
  assert.deepEqual(requiredSkillsFor('something_new'), ['general_plumbing']);
});

// --- hard filters ---------------------------------------------------------

test('a partner missing a required skill is never assigned, however close', () => {
  const result = scorePartners(
    { ...JOB_SITE, job_type: 'gas_line', urgency: 'standard' },
    [
      partner({ id: 'next-door', skills: ['general_plumbing'] }), // 0km, unqualified
      partner({ id: 'far-but-qualified', base_lat: 30.55, base_lng: -97.9, skills: ['gas_line'], service_radius_km: 60 }),
    ]
  );

  assert.equal(result.assigned.partner.id, 'far-but-qualified');
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /missing required skill/);
});

test('a partner outside their own service radius is excluded', () => {
  const result = scorePartners({ ...JOB_SITE, job_type: 'leak_repair' }, [
    partner({ id: 'too-far', base_lat: 31.5, base_lng: -97.7431, service_radius_km: 20 }),
  ]);

  assert.equal(result.assigned, null);
  assert.match(result.rejected[0].reason, /outside their 20km service radius/);
});

test('a partner already at capacity is excluded', () => {
  const result = scorePartners({ ...JOB_SITE, job_type: 'leak_repair' }, [
    partner({ id: 'booked-solid', max_jobs_per_day: 4, jobs_today: 4 }),
  ]);

  assert.equal(result.assigned, null);
  assert.match(result.rejected[0].reason, /at capacity \(4\/4 jobs\)/);
});

test('an inactive partner is excluded', () => {
  const result = scorePartners({ ...JOB_SITE, job_type: 'leak_repair' }, [
    partner({ id: 'on-leave', active: false }),
  ]);

  assert.equal(result.assigned, null);
  assert.equal(result.rejected[0].reason, 'inactive');
});

test('no eligible partner returns assigned:null rather than throwing', () => {
  // Dispatch must degrade gracefully — the workflow branches on this to alert
  // the owner, instead of the whole execution erroring out.
  const result = scorePartners({ ...JOB_SITE, job_type: 'sewer_line' }, [
    partner({ id: 'a' }),
    partner({ id: 'b' }),
  ]);
  assert.equal(result.assigned, null);
  assert.equal(result.ranked.length, 0);
  assert.equal(result.rejected.length, 2);
});

test('an empty partner list is handled', () => {
  const result = scorePartners({ ...JOB_SITE, job_type: 'leak_repair' }, []);
  assert.equal(result.assigned, null);
});

test('missing coordinates throw a clear error rather than silently misassigning', () => {
  assert.throws(
    () => scorePartners({ job_type: 'leak_repair' }, [partner()]),
    /job.lat and job.lng are required/
  );
});

// --- soft scoring ---------------------------------------------------------

test('with equal skills and load, the closer partner wins', () => {
  const result = scorePartners({ ...JOB_SITE, job_type: 'leak_repair' }, [
    partner({ id: 'far', base_lat: 30.50, base_lng: -97.90 }),
    partner({ id: 'near', base_lat: 30.27, base_lng: -97.75 }),
  ]);

  assert.equal(result.assigned.partner.id, 'near');
});

test('an emergency weights proximity far more heavily than load balancing', () => {
  const partners = [
    // Right next door but nearly booked out.
    partner({ id: 'close-busy', base_lat: 30.2672, base_lng: -97.7431, jobs_today: 5, max_jobs_per_day: 6, skills: ['general_plumbing', 'emergency'] }),
    // Free all day but 25km away.
    partner({ id: 'far-free', base_lat: 30.49, base_lng: -97.74, jobs_today: 0, max_jobs_per_day: 6, skills: ['general_plumbing', 'emergency'] }),
  ];

  const emergency = scorePartners({ ...JOB_SITE, job_type: 'emergency_burst', urgency: 'emergency' }, partners);
  assert.equal(emergency.assigned.partner.id, 'close-busy',
    'a burst pipe should go to whoever can get there fastest');

  // The same two partners on a flexible job: now spreading load wins.
  const flexible = scorePartners({ ...JOB_SITE, job_type: 'emergency_burst', urgency: 'flexible' }, partners);
  assert.equal(flexible.assigned.partner.id, 'far-free',
    'non-urgent work should go to whoever has capacity');
});

test('load balancing breaks a tie between two equally-placed partners', () => {
  const result = scorePartners({ ...JOB_SITE, job_type: 'leak_repair' }, [
    partner({ id: 'loaded', jobs_today: 4 }),
    partner({ id: 'free', jobs_today: 0 }),
  ]);

  assert.equal(result.assigned.partner.id, 'free');
});

test('the specialist beats the generalist when both qualify and are equidistant', () => {
  const result = scorePartners({ ...JOB_SITE, job_type: 'gas_line' }, [
    partner({ id: 'generalist', skills: ['general_plumbing', 'drain', 'sewer', 'gas_line', 'repipe', 'excavation'] }),
    partner({ id: 'gas-specialist', skills: ['gas_line'] }),
  ]);

  assert.equal(result.assigned.partner.id, 'gas-specialist');
});

test('ranking is deterministic for identical partners', () => {
  // Two partners identical in every scored dimension. Without an explicit
  // tie-break this would depend on array order, and the same booking could be
  // dispatched to a different person on a retry.
  const a = partner({ id: 'aaa' });
  const b = partner({ id: 'bbb' });

  const first = scorePartners({ ...JOB_SITE, job_type: 'leak_repair' }, [a, b]);
  const second = scorePartners({ ...JOB_SITE, job_type: 'leak_repair' }, [b, a]);

  assert.equal(first.assigned.partner.id, second.assigned.partner.id);
  assert.equal(first.assigned.partner.id, 'aaa');
});

test('every ranked result explains itself', () => {
  const result = scorePartners({ ...JOB_SITE, job_type: 'water_heater' }, [
    partner({ id: 'p1', skills: ['general_plumbing', 'water_heater'] }),
  ]);

  const top = result.assigned;
  assert.equal(top.reasons.length, 3);
  assert.match(top.reasons[1], /holds all required skills/);
  assert.ok(top.score > 0 && top.score <= 1);
  assert.ok('proximity' in top.breakdown);
});
