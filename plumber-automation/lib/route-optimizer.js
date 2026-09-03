'use strict';

/**
 * Daily route building — spec step 8.
 *
 * "Add their location and time to the plumber's GPS route for tomorrow,
 * optimized to have the most efficient route."
 *
 * THE TENSION NOBODY MENTIONS:
 * A pure shortest-path tour (classic travelling-salesman) will happily put a
 * 4pm appointment at 9am because it is geographically convenient. The customer
 * was PROMISED a window. Breaking that to save eight minutes of driving is a
 * bad trade, and it is the fastest way to make a plumber stop trusting the
 * software.
 *
 * So this optimises in two tiers:
 *   1. Appointment windows are hard constraints. Stops are grouped by the
 *      window the customer was promised, and groups run in time order.
 *   2. WITHIN a window, where the plumber is genuinely free to choose, we
 *      minimise driving.
 *
 * That is where the real savings are anyway: a morning block of four jobs
 * driven in a sensible order versus a silly one is the difference that matters.
 */

const { haversineKm } = require('./partner-scoring.js');

/** Average city driving speed, for ETA estimates without a maps call. */
const AVG_SPEED_KMH = 32;
/** How long a stop takes if the job type doesn't say. */
const DEFAULT_SERVICE_MINUTES = 60;

/** Rough drive time between two points, in seconds. */
function estimateDriveSeconds(a, b) {
  const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
  // Straight-line distance understates real roads; 1.35 is a standard
  // "circuity factor" for US metro street grids.
  return Math.round(((km * 1.35) / AVG_SPEED_KMH) * 3600);
}

/**
 * Greedy nearest-neighbour tour. Fast, and good enough as a starting point
 * for the improvement pass below.
 */
function nearestNeighbourOrder(origin, stops) {
  const remaining = stops.map((s, i) => ({ ...s, _i: i }));
  const order = [];
  let current = origin;

  while (remaining.length) {
    let bestIdx = 0;
    let bestKm = Infinity;
    remaining.forEach((s, idx) => {
      const km = haversineKm(current.lat, current.lng, s.lat, s.lng);
      // Deterministic tie-break, so the same day always routes the same way.
      if (km < bestKm - 1e-9 || (Math.abs(km - bestKm) < 1e-9 && idx < bestIdx)) {
        bestKm = km;
        bestIdx = idx;
      }
    });
    const [chosen] = remaining.splice(bestIdx, 1);
    order.push(chosen._i);
    current = chosen;
  }

  return order;
}

/**
 * Length of a path: `from` -> stops in `order` -> `to`.
 *
 * `to` matters more than it looks. Optimising each window as a round trip back
 * to base makes the morning block end wherever is cheapest to return from —
 * and then the plumber drives right back across town to the first afternoon
 * job. Passing the NEXT window's centre as `to` makes each block finish
 * pointing the right way. Pass the origin as `to` for the final block, where
 * going home really is the last leg.
 */
function pathLengthKm(from, stops, order, to) {
  let total = 0;
  let current = from;
  for (const idx of order) {
    total += haversineKm(current.lat, current.lng, stops[idx].lat, stops[idx].lng);
    current = stops[idx];
  }
  if (to) total += haversineKm(current.lat, current.lng, to.lat, to.lng);
  return total;
}

/** Closed tour: origin -> stops -> back to origin. */
function tourLengthKm(origin, stops, order) {
  return pathLengthKm(origin, stops, order, origin);
}

/** The average position of a group of stops — used as the "aim for" point. */
function centroid(stops) {
  if (!stops.length) return null;
  return {
    lat: stops.reduce((s, p) => s + p.lat, 0) / stops.length,
    lng: stops.reduce((s, p) => s + p.lng, 0) / stops.length,
  };
}

/**
 * 2-opt improvement: repeatedly reverse a segment of the tour if doing so
 * shortens it. Cheap, and reliably fixes the crossing-over paths that greedy
 * nearest-neighbour leaves behind.
 *
 * A plumber's day is at most a handful of stops, so an exhaustive pass is
 * instant — no need for anything cleverer.
 */
function twoOptImprove(from, stops, order, to, maxPasses = 12) {
  let best = [...order];
  let bestLength = pathLengthKm(from, stops, best, to);

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;

    for (let i = 0; i < best.length - 1; i += 1) {
      for (let k = i + 1; k < best.length; k += 1) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const length = pathLengthKm(from, stops, candidate, to);
        if (length < bestLength - 1e-9) {
          best = candidate;
          bestLength = length;
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return { order: best, distanceKm: bestLength };
}

/**
 * The promised arrival window a stop belongs to, as a sortable key.
 * Stops sharing a key may be reordered freely; stops in different keys may not.
 */
function windowKey(stop) {
  if (stop.window_start) return new Date(stop.window_start).getTime();
  return new Date(stop.scheduled_start).getTime();
}

/**
 * Group stops into the windows they were promised.
 * Appointments within `toleranceMinutes` of each other count as the same
 * window and can be reordered against one another.
 */
function groupByWindow(stops, toleranceMinutes = 120) {
  const sorted = [...stops].sort((a, b) => windowKey(a) - windowKey(b));
  const groups = [];
  const toleranceMs = toleranceMinutes * 60000;

  for (const stop of sorted) {
    const last = groups[groups.length - 1];
    if (last && windowKey(stop) - windowKey(last[0]) <= toleranceMs) {
      last.push(stop);
    } else {
      groups.push([stop]);
    }
  }

  return groups;
}

/**
 * Build tomorrow's route.
 *
 * @param {object} opts
 *   @param {{lat:number,lng:number}} opts.origin        the partner's base
 *   @param {Array} opts.stops        each { job_id, lat, lng, scheduled_start,
 *                                          service_minutes?, ... }
 *   @param {string|Date} [opts.startTime]  when the plumber leaves base
 *   @param {number} [opts.windowToleranceMinutes=120]
 * @returns {{stops: Array, totalDistanceKm: number, totalDriveMinutes: number}}
 */
function buildRoute({ origin, stops, startTime, windowToleranceMinutes = 120 }) {
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) {
    throw new Error('buildRoute: origin must have numeric lat and lng');
  }

  const usable = (stops || []).filter(
    (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)
  );
  const skipped = (stops || []).filter(
    (s) => !Number.isFinite(s.lat) || !Number.isFinite(s.lng)
  );

  if (!usable.length) {
    return { stops: [], skipped, totalDistanceKm: 0, totalDriveMinutes: 0 };
  }

  // --- tier 1: respect the promised windows -----------------------------
  const groups = groupByWindow(usable, windowToleranceMinutes);

  // --- tier 2: minimise driving inside each window ----------------------
  const ordered = [];
  let current = origin;
  let totalDistanceKm = 0;

  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    // Aim the end of this block at the next block; the last block aims home.
    const nextGroup = groups[g + 1];
    const aimFor = nextGroup ? centroid(nextGroup) : origin;

    const greedy = nearestNeighbourOrder(current, group);
    const { order } = twoOptImprove(current, group, greedy, aimFor);

    for (const idx of order) {
      const stop = group[idx];
      totalDistanceKm += haversineKm(current.lat, current.lng, stop.lat, stop.lng);
      ordered.push(stop);
      current = stop;
    }
  }

  totalDistanceKm += haversineKm(current.lat, current.lng, origin.lat, origin.lng);

  // --- ETAs -------------------------------------------------------------
  const start = startTime
    ? new Date(startTime)
    : new Date(Math.min(...ordered.map((s) => new Date(s.scheduled_start).getTime())));

  let clock = start.getTime();
  let previous = origin;
  let totalDriveSeconds = 0;

  const withEtas = ordered.map((stop, i) => {
    const driveSeconds = estimateDriveSeconds(previous, stop);
    totalDriveSeconds += driveSeconds;
    clock += driveSeconds * 1000;

    // Never show an ETA earlier than the window the customer was promised —
    // arriving early is fine, but telling them 8:15 for a 9:00 slot is not.
    const promised = new Date(stop.scheduled_start).getTime();
    if (clock < promised) clock = promised;

    const eta = new Date(clock);
    const serviceMinutes = stop.service_minutes || DEFAULT_SERVICE_MINUTES;
    clock += serviceMinutes * 60000;
    previous = stop;

    return {
      ...stop,
      stop_order: i + 1,
      eta: eta.toISOString(),
      drive_seconds: driveSeconds,
      distance_meters: Math.round(haversineKm(
        i === 0 ? origin.lat : ordered[i - 1].lat,
        i === 0 ? origin.lng : ordered[i - 1].lng,
        stop.lat, stop.lng
      ) * 1350),
      service_minutes: serviceMinutes,
    };
  });

  return {
    stops: withEtas,
    skipped,
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    totalDriveMinutes: Math.round(totalDriveSeconds / 60),
  };
}

/**
 * Apply an order returned by the Google Routes API to our stop list.
 * Google gives back optimizedIntermediateWaypointIndex — the indices of the
 * intermediates in the order they should be driven.
 */
function applyGoogleOrder(stops, optimizedIndices) {
  if (!Array.isArray(optimizedIndices) || optimizedIndices.length !== stops.length) {
    throw new Error(
      `route order mismatch: got ${optimizedIndices?.length} indices for ${stops.length} stops`
    );
  }
  return optimizedIndices.map((i) => stops[i]);
}

/**
 * How much the optimisation actually saved, versus driving the stops in the
 * order they were booked. This is the number you put in front of the client
 * when justifying the retainer.
 */
function savingsVersusBookedOrder({ origin, stops, optimisedStops }) {
  const naive = [...stops].sort(
    (a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start)
  );
  const naiveKm = tourLengthKm(origin, naive, naive.map((_, i) => i));
  const optimisedKm = tourLengthKm(origin, optimisedStops, optimisedStops.map((_, i) => i));

  return {
    naiveKm: Number(naiveKm.toFixed(2)),
    optimisedKm: Number(optimisedKm.toFixed(2)),
    savedKm: Number((naiveKm - optimisedKm).toFixed(2)),
    savedPercent: naiveKm > 0 ? Number((((naiveKm - optimisedKm) / naiveKm) * 100).toFixed(1)) : 0,
  };
}

module.exports = {
  buildRoute,
  nearestNeighbourOrder,
  twoOptImprove,
  tourLengthKm,
  pathLengthKm,
  centroid,
  groupByWindow,
  estimateDriveSeconds,
  applyGoogleOrder,
  savingsVersusBookedOrder,
  AVG_SPEED_KMH,
  DEFAULT_SERVICE_MINUTES,
};
