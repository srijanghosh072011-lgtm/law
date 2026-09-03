'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRoute, nearestNeighbourOrder, twoOptImprove, tourLengthKm,
  groupByWindow, applyGoogleOrder, savingsVersusBookedOrder, centroid,
} = require('../lib/route-optimizer.js');

const BASE = { lat: 30.2672, lng: -97.7431 };  // downtown Austin
const MORNING = '2026-09-04T13:00:00Z';
const AFTERNOON = '2026-09-04T19:00:00Z';

const stop = (id, lat, lng, when = MORNING, over = {}) => ({
  job_id: id, lat, lng, scheduled_start: when, ...over,
});

// --- ordering -------------------------------------------------------------

test('nearest-neighbour visits the closest stop first', () => {
  const stops = [stop('far', 30.60, -97.74), stop('near', 30.28, -97.74)];
  const order = nearestNeighbourOrder(BASE, stops);
  assert.equal(stops[order[0]].job_id, 'near');
});

test('2-opt shortens a deliberately crossed tour', () => {
  // A zig-zag that greedy ordering leaves crossing over itself.
  const stops = [
    stop('a', 30.40, -97.70), stop('b', 30.20, -97.80),
    stop('c', 30.38, -97.72), stop('d', 30.22, -97.78),
  ];
  const naive = [0, 1, 2, 3];
  const before = tourLengthKm(BASE, stops, naive);
  const { order, distanceKm } = twoOptImprove(BASE, stops, naive, BASE);

  assert.ok(distanceKm <= before, '2-opt must never make a tour longer');
  assert.ok(distanceKm < before, 'this tour crosses itself and should improve');
  assert.equal(new Set(order).size, 4, 'every stop must still appear exactly once');
});

test('optimisation is deterministic — the same day routes the same way', () => {
  // A route that changes between runs destroys the plumber's trust in it.
  const stops = [stop('a', 30.40, -97.70), stop('b', 30.20, -97.80), stop('c', 30.30, -97.75)];
  const first = buildRoute({ origin: BASE, stops, startTime: MORNING });
  const second = buildRoute({ origin: BASE, stops: [...stops].reverse(), startTime: MORNING });

  assert.deepEqual(
    first.stops.map((s) => s.job_id),
    second.stops.map((s) => s.job_id)
  );
});

// --- appointment windows are hard constraints ----------------------------

test('a geographically convenient afternoon job is NOT pulled into the morning', () => {
  // THE RULE THAT MATTERS. The customer was promised an afternoon window.
  // Saving a few minutes of driving is not worth breaking that promise.
  const stops = [
    stop('morning-far', 30.50, -97.80, MORNING),
    stop('afternoon-next-door', 30.2673, -97.7432, AFTERNOON),
  ];

  const route = buildRoute({ origin: BASE, stops, startTime: MORNING });
  assert.equal(route.stops[0].job_id, 'morning-far');
  assert.equal(route.stops[1].job_id, 'afternoon-next-door');
});

test('stops are grouped by the window the customer was promised', () => {
  const groups = groupByWindow([
    stop('m1', 30.3, -97.7, MORNING),
    stop('a1', 30.3, -97.7, AFTERNOON),
    stop('m2', 30.4, -97.7, MORNING),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((s) => s.job_id).sort(), ['m1', 'm2']);
  assert.deepEqual(groups[1].map((s) => s.job_id), ['a1']);
});

test('within one window, driving really is minimised', () => {
  // Booked in a deliberately silly order; all in the same window, so the
  // optimiser is free to fix it.
  const stops = [
    stop('far-north', 30.45, -97.75),
    stop('downtown',  30.27, -97.74),
    stop('far-south', 30.10, -97.80),
    stop('near-down', 30.29, -97.72),
  ];

  const route = buildRoute({ origin: BASE, stops, startTime: MORNING });
  const savings = savingsVersusBookedOrder({
    origin: BASE, stops, optimisedStops: route.stops,
  });

  assert.ok(savings.savedKm > 0, 'should beat the booked order');
  assert.equal(route.stops.length, 4);
});

test('each window block finishes pointing at the next one', () => {
  // Optimising each block as a round trip back to base sends the plumber
  // across town and back. The morning must end near the afternoon work.
  const stops = [
    stop('m-north', 30.45, -97.75, MORNING),
    stop('m-south', 30.10, -97.80, MORNING),
    stop('m-central', 30.27, -97.74, MORNING),
    stop('a-north', 30.44, -97.76, AFTERNOON),
  ];

  const route = buildRoute({ origin: BASE, stops, startTime: MORNING });
  const morningOrder = route.stops.filter((s) => s.job_id.startsWith('m-'));

  assert.equal(morningOrder[morningOrder.length - 1].job_id, 'm-north',
    'the last morning stop should be the one nearest the afternoon job');
});

// --- ETAs -----------------------------------------------------------------

test('ETAs increase monotonically down the route', () => {
  const stops = [
    stop('a', 30.30, -97.75), stop('b', 30.35, -97.72), stop('c', 30.40, -97.70),
  ];
  const route = buildRoute({ origin: BASE, stops, startTime: MORNING });

  for (let i = 1; i < route.stops.length; i += 1) {
    assert.ok(
      new Date(route.stops[i].eta) > new Date(route.stops[i - 1].eta),
      'each stop must be later than the one before it'
    );
  }
});

test('an ETA is never earlier than the window the customer was promised', () => {
  // Arriving early is fine. Telling someone 8:15 for a 9:00 slot is not.
  const stops = [stop('later', 30.268, -97.744, '2026-09-04T16:00:00Z')];
  const route = buildRoute({ origin: BASE, stops, startTime: MORNING });

  assert.ok(new Date(route.stops[0].eta) >= new Date('2026-09-04T16:00:00Z'));
});

test('service time is accounted for between stops', () => {
  const stops = [
    stop('long', 30.268, -97.744, MORNING, { service_minutes: 180 }),
    stop('next', 30.269, -97.745, MORNING),
  ];
  const route = buildRoute({ origin: BASE, stops, startTime: MORNING });

  const gapMinutes =
    (new Date(route.stops[1].eta) - new Date(route.stops[0].eta)) / 60000;
  assert.ok(gapMinutes >= 180, `expected at least the 180min job, got ${gapMinutes}`);
});

test('stop_order is 1-based and contiguous', () => {
  const stops = [stop('a', 30.3, -97.75), stop('b', 30.35, -97.72), stop('c', 30.4, -97.7)];
  const route = buildRoute({ origin: BASE, stops, startTime: MORNING });
  assert.deepEqual(route.stops.map((s) => s.stop_order), [1, 2, 3]);
});

// --- degenerate cases -----------------------------------------------------

test('an empty day produces an empty route rather than an error', () => {
  const route = buildRoute({ origin: BASE, stops: [], startTime: MORNING });
  assert.deepEqual(route.stops, []);
  assert.equal(route.totalDistanceKm, 0);
});

test('a single stop routes trivially', () => {
  const route = buildRoute({ origin: BASE, stops: [stop('only', 30.30, -97.75)], startTime: MORNING });
  assert.equal(route.stops.length, 1);
  assert.equal(route.stops[0].stop_order, 1);
});

test('a stop with no coordinates is set aside, not silently dropped', () => {
  // Geocoding failed for this address. It must surface as `skipped` so
  // somebody fixes it — a job that vanishes from the route is worse than a
  // job flagged as unroutable.
  const stops = [
    stop('good', 30.30, -97.75),
    { job_id: 'ungeocoded', lat: null, lng: null, scheduled_start: MORNING },
  ];
  const route = buildRoute({ origin: BASE, stops, startTime: MORNING });

  assert.equal(route.stops.length, 1);
  assert.equal(route.skipped.length, 1);
  assert.equal(route.skipped[0].job_id, 'ungeocoded');
});

test('a bad origin fails loudly rather than routing from null island', () => {
  assert.throws(
    () => buildRoute({ origin: { lat: null, lng: null }, stops: [stop('a', 30.3, -97.7)] }),
    /origin must have numeric/
  );
});

// --- Google Routes API interop -------------------------------------------

test("Google's optimised order is applied to our stops", () => {
  const stops = [stop('a', 30.3, -97.7), stop('b', 30.4, -97.7), stop('c', 30.5, -97.7)];
  assert.deepEqual(
    applyGoogleOrder(stops, [2, 0, 1]).map((s) => s.job_id),
    ['c', 'a', 'b']
  );
});

test('a mismatched order from Google is rejected, not partially applied', () => {
  // Silently applying a short index list would drop stops from the day.
  const stops = [stop('a', 30.3, -97.7), stop('b', 30.4, -97.7)];
  assert.throws(() => applyGoogleOrder(stops, [0]), /route order mismatch/);
  assert.throws(() => applyGoogleOrder(stops, undefined), /route order mismatch/);
});

test('centroid averages a group of stops', () => {
  const c = centroid([stop('a', 30.0, -97.0), stop('b', 31.0, -98.0)]);
  assert.equal(c.lat, 30.5);
  assert.equal(c.lng, -97.5);
});
