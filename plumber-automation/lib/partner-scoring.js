'use strict';

/**
 * Partner dispatch scoring — spec step 3.
 *
 * "Send the job to the relevant partner based on geographical location and the
 * skills and expertise required."
 *
 * Two stages, deliberately separated:
 *
 *   1. HARD FILTERS  — disqualify anyone who *cannot* take the job. A partner
 *      without a gas licence must never surface, no matter how close they are.
 *   2. SOFT SCORING  — rank whoever survives, by how good a fit they are.
 *
 * Every result carries a human-readable `reasons` array. When the plumber asks
 * "why did Dave get that job?", you can answer without reading code.
 */

/**
 * Which skills each job type demands. The right-hand side is ALL required —
 * a partner must hold every one of them.
 *
 * Keep this in sync with the job types offered on the booking form
 * (web/booking.html) and with the `skills` column in the partners table.
 */
const JOB_TYPE_SKILLS = {
  leak_repair:      ['general_plumbing'],
  drain_cleaning:   ['general_plumbing', 'drain'],
  water_heater:     ['general_plumbing', 'water_heater'],
  tankless_install: ['general_plumbing', 'water_heater', 'gas_line'],
  gas_line:         ['gas_line'],
  sewer_line:       ['general_plumbing', 'sewer', 'excavation'],
  repipe:           ['general_plumbing', 'repipe'],
  fixture_install:  ['general_plumbing'],
  backflow_test:    ['backflow_certified'],
  emergency_burst:  ['general_plumbing', 'emergency'],
};

/** Weighting profiles. Emergencies care about who is CLOSE, above all else. */
const WEIGHTS = {
  emergency: { proximity: 0.65, skill: 0.25, availability: 0.10 },
  standard:  { proximity: 0.45, skill: 0.35, availability: 0.20 },
  flexible:  { proximity: 0.30, skill: 0.35, availability: 0.35 },
};

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in km. Straight-line, not driving distance — that is
 * intentional: this runs over every partner on every booking, and calling a
 * maps API per partner would be slow and expensive. Real driving distance is
 * used later, in route-optimizer.js, where it actually matters.
 */
function haversineKm(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Skills a job type needs. Unknown types fall back to general plumbing. */
function requiredSkillsFor(jobType) {
  return JOB_TYPE_SKILLS[jobType] || ['general_plumbing'];
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Rank partners for a job.
 *
 * @param {object} job
 *   @param {number} job.lat
 *   @param {number} job.lng
 *   @param {string} job.job_type
 *   @param {string} [job.urgency='standard']  emergency | standard | flexible
 * @param {Array<object>} partners  rows from the `partners` table, each
 *   optionally carrying `jobs_today` (a COUNT joined in by the caller).
 * @returns {{ranked: Array, rejected: Array, assigned: object|null}}
 */
function scorePartners(job, partners) {
  if (!Number.isFinite(job?.lat) || !Number.isFinite(job?.lng)) {
    throw new Error('scorePartners: job.lat and job.lng are required numbers');
  }

  const required = requiredSkillsFor(job.job_type);
  const weights = WEIGHTS[job.urgency] || WEIGHTS.standard;

  const ranked = [];
  const rejected = [];

  for (const p of partners || []) {
    const skills = p.skills || [];
    const distanceKm = haversineKm(job.lat, job.lng, p.base_lat, p.base_lng);
    const radius = p.service_radius_km ?? 40;
    const maxJobs = p.max_jobs_per_day ?? 6;
    const jobsToday = p.jobs_today ?? 0;
    const missing = required.filter((s) => !skills.includes(s));

    // --- Stage 1: hard filters -------------------------------------------
    if (p.active === false) {
      rejected.push({ partner: p, reason: 'inactive' });
      continue;
    }
    if (missing.length > 0) {
      rejected.push({
        partner: p,
        reason: `missing required skill(s): ${missing.join(', ')}`,
      });
      continue;
    }
    if (distanceKm > radius) {
      rejected.push({
        partner: p,
        reason: `${distanceKm.toFixed(1)}km away, outside their ${radius}km service radius`,
      });
      continue;
    }
    if (jobsToday >= maxJobs) {
      rejected.push({
        partner: p,
        reason: `already at capacity (${jobsToday}/${maxJobs} jobs)`,
      });
      continue;
    }

    // --- Stage 2: soft scoring -------------------------------------------
    // Closer is better, measured against their own radius so a partner with a
    // small radius isn't punished for it.
    const proximity = clamp01(1 - distanceKm / radius);

    // They already hold every required skill. What separates them now is
    // depth: someone whose skill set is *concentrated* on this work is a
    // better fit than a generalist who happens to qualify. Capped so a
    // narrow one-trick partner doesn't automatically beat a strong all-rounder.
    const specialisation = clamp01(required.length / Math.max(skills.length, 1));
    const skill = clamp01(0.75 + 0.25 * specialisation);

    // Spread work across the crew rather than hammering one person.
    const availability = clamp01(1 - jobsToday / maxJobs);

    const score =
      weights.proximity * proximity +
      weights.skill * skill +
      weights.availability * availability;

    ranked.push({
      partner: p,
      score: Number(score.toFixed(4)),
      distanceKm: Number(distanceKm.toFixed(2)),
      breakdown: {
        proximity: Number(proximity.toFixed(4)),
        skill: Number(skill.toFixed(4)),
        availability: Number(availability.toFixed(4)),
      },
      reasons: [
        `${distanceKm.toFixed(1)}km from base (radius ${radius}km)`,
        `holds all required skills: ${required.join(', ')}`,
        `${jobsToday}/${maxJobs} jobs booked that day`,
      ],
    });
  }

  // Highest score wins. Ties break on distance, then on id — never on array
  // order, so the same inputs always produce the same assignment.
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.distanceKm - b.distanceKm ||
      String(a.partner.id).localeCompare(String(b.partner.id))
  );

  return {
    ranked,
    rejected,
    assigned: ranked[0] || null,
  };
}

module.exports = {
  scorePartners,
  haversineKm,
  requiredSkillsFor,
  JOB_TYPE_SKILLS,
  WEIGHTS,
};
