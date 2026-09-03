'use strict';

/**
 * Mock vendor server.
 *
 * Stands in for GoHighLevel, Twilio, SendGrid, Google Maps, Claude and
 * QuickBooks so the entire automation runs end-to-end with zero paid accounts
 * and zero risk of texting a real human.
 *
 * Deliberately has NO npm dependencies — Node's built-in http module only —
 * so `node mock/server.js` works on a clean machine with nothing installed.
 *
 * Response SHAPES match the real vendors. That matters: when you flip
 * MOCK_MODE=false, the workflows' field mappings ($.sid, $.contact.id,
 * $.QueryResponse...) keep working unchanged.
 *
 *   GET  /__timeline   every call made, in order — this is your demo output
 *   POST /__reset      clear the timeline
 *   GET  /__health     liveness
 */

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4000);

/** Every intercepted call, in order. The demo prints this. */
const timeline = [];
/** In-memory vendor state, so reads reflect earlier writes. */
const store = {
  contacts: new Map(),
  opportunities: new Map(),
  invoices: new Map(),
  messages: [],
};

function log(service, action, detail) {
  const entry = {
    seq: timeline.length + 1,
    at: new Date().toISOString(),
    service,
    action,
    detail,
  };
  timeline.push(entry);

  // Human-readable console line — this is what you watch during a demo.
  const summary =
    detail.summary || `${detail.to || detail.name || ''}`.trim() || '';
  console.log(
    `[${String(entry.seq).padStart(3, '0')}] ${service.padEnd(10)} ${action.padEnd(24)} ${summary}`
  );
  return entry;
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

/**
 * Deterministic fake geocoder. Hashes the address into a small offset around a
 * city centre, so the same address always yields the same coordinates and
 * route tests are reproducible. Real geocoding is a live Google call.
 */
const CITY_CENTRE = { lat: 30.2672, lng: -97.7431 }; // Austin, TX
function fakeGeocode(address) {
  const h = crypto.createHash('sha256').update(String(address)).digest();
  // Spread within roughly +/- 0.18 degrees (~20km).
  const latOff = ((h[0] / 255) - 0.5) * 0.36;
  const lngOff = ((h[1] / 255) - 0.5) * 0.36;
  return {
    lat: Number((CITY_CENTRE.lat + latOff).toFixed(6)),
    lng: Number((CITY_CENTRE.lng + lngOff).toFixed(6)),
  };
}

// ---------------------------------------------------------------------------
// Route handlers. Each returns [statusCode, body].
// ---------------------------------------------------------------------------
const routes = [
  // --- GoHighLevel: contacts (spec step 2) ---------------------------------
  {
    method: 'POST',
    match: /^\/ghl\/contacts\/upsert$/,
    handler: (body) => {
      // GHL upserts on phone/email — same behaviour here so repeat customers
      // don't create duplicate contacts.
      const existing = [...store.contacts.values()].find(
        (c) => c.phone === body.phone || c.email === body.email
      );
      const contact = existing
        ? { ...existing, ...body }
        : { id: id('ghl_contact'), ...body, dateAdded: new Date().toISOString() };
      store.contacts.set(contact.id, contact);
      log('ghl', existing ? 'contact.updated' : 'contact.created', {
        summary: `${contact.firstName || ''} ${contact.lastName || ''} <${contact.email}>`.trim(),
        contactId: contact.id,
      });
      return [200, { contact, new: !existing }];
    },
  },
  {
    method: 'POST',
    match: /^\/ghl\/opportunities$/,
    handler: (body) => {
      const opp = { id: id('ghl_opp'), ...body, createdAt: new Date().toISOString() };
      store.opportunities.set(opp.id, opp);
      log('ghl', 'opportunity.created', {
        summary: `${opp.name || 'job'} -> stage ${opp.pipelineStageId || 'booked'}`,
        opportunityId: opp.id,
      });
      return [200, { opportunity: opp }];
    },
  },
  {
    method: 'PUT',
    match: /^\/ghl\/opportunities\/([^/]+)$/,
    handler: (body, [oppId]) => {
      const opp = { ...(store.opportunities.get(oppId) || { id: oppId }), ...body };
      store.opportunities.set(oppId, opp);
      log('ghl', 'opportunity.updated', {
        summary: `${oppId} -> ${body.pipelineStageId || body.status || 'updated'}`,
      });
      return [200, { opportunity: opp }];
    },
  },
  {
    method: 'POST',
    match: /^\/ghl\/contacts\/([^/]+)\/tags$/,
    handler: (body, [contactId]) => {
      const tags = body.tags || [];
      log('ghl', 'contact.tagged', { summary: `${contactId} += [${tags.join(', ')}]` });
      return [200, { tags }];
    },
  },
  // GHL campaign/workflow enrolment — steps 6 and 15 (nurture + reactivation).
  {
    method: 'POST',
    match: /^\/ghl\/campaigns\/([^/]+)\/enroll$/,
    handler: (body, [campaign]) => {
      log('ghl', 'campaign.enrolled', {
        summary: `${body.contactId} -> "${campaign}"`,
      });
      return [200, { enrolled: true, campaign, contactId: body.contactId }];
    },
  },

  // --- Twilio: SMS (steps 1, 4, 9) -----------------------------------------
  {
    method: 'POST',
    match: /^\/twilio\/2010-04-01\/Accounts\/([^/]+)\/Messages\.json$/,
    handler: (body) => {
      const sid = `SM${crypto.randomBytes(16).toString('hex')}`;
      const msg = {
        sid,
        to: body.To,
        from: body.From,
        body: body.Body,
        status: 'queued',
        date_created: new Date().toISOString(),
      };
      store.messages.push(msg);
      log('twilio', 'sms.sent', {
        summary: `${body.To}: "${String(body.Body || '').slice(0, 70)}${String(body.Body || '').length > 70 ? '…' : ''}"`,
        to: body.To,
        body: body.Body,
      });
      return [201, msg];
    },
  },

  // --- Email (steps 1, 10, 12, 14) -----------------------------------------
  {
    method: 'POST',
    match: /^\/email\/v3\/mail\/send$/,
    handler: (body) => {
      const to =
        body.personalizations?.[0]?.to?.[0]?.email || body.to || 'unknown@example.com';
      const subject = body.subject || body.personalizations?.[0]?.subject || '(no subject)';
      log('email', 'email.sent', { summary: `${to}: "${subject}"`, to, subject });
      return [202, { message_id: id('email') }];
    },
  },

  // --- Google Maps: geocoding + route optimization (steps 8, 9) ------------
  {
    method: 'POST',
    match: /^\/maps\/geocode$/,
    handler: (body) => {
      const coords = fakeGeocode(body.address);
      log('maps', 'geocode', { summary: `${body.address} -> ${coords.lat},${coords.lng}` });
      return [200, { results: [{ geometry: { location: coords } }], status: 'OK' }];
    },
  },
  {
    method: 'POST',
    match: /^\/maps\/directions\/v2:computeRoutes$/,
    handler: (body) => {
      // Real Routes API returns optimizedIntermediateWaypointIndex. We produce
      // the same field via nearest-neighbour so downstream mapping is identical.
      const waypoints = body.intermediates || [];
      const origin = body.origin?.location?.latLng || { latitude: CITY_CENTRE.lat, longitude: CITY_CENTRE.lng };
      const order = nearestNeighbourOrder(origin, waypoints);
      const legs = order.map((idx, i) => ({
        distanceMeters: 3000 + ((i * 1700) % 9000),
        duration: `${300 + ((i * 220) % 1500)}s`,
        optimizedIntermediateWaypointIndex: idx,
      }));
      log('maps', 'route.optimized', {
        summary: `${waypoints.length} stops -> order [${order.join(', ')}]`,
        order,
      });
      return [
        200,
        {
          routes: [
            {
              optimizedIntermediateWaypointIndex: order,
              distanceMeters: legs.reduce((s, l) => s + l.distanceMeters, 0),
              duration: `${legs.reduce((s, l) => s + parseInt(l.duration, 10), 0)}s`,
              legs,
            },
          ],
        },
      ];
    },
  },
  // ETA for the "on my way" text (step 9).
  {
    method: 'POST',
    match: /^\/maps\/eta$/,
    handler: (body) => {
      const minutes = 8 + (crypto.createHash('sha256').update(String(body.destination)).digest()[0] % 22);
      log('maps', 'eta.computed', { summary: `${minutes} min to ${body.destination}` });
      return [200, { durationMinutes: minutes, distanceMeters: minutes * 700 }];
    },
  },

  // --- Claude: post-job report (step 10) -----------------------------------
  {
    method: 'POST',
    match: /^\/anthropic\/v1\/messages$/,
    handler: (body) => {
      const prompt = JSON.stringify(body.messages || []);
      const report = mockReport(prompt);
      log('anthropic', 'report.generated', {
        summary: `${body.model || 'claude'} -> ${report.length} chars`,
      });
      return [
        200,
        {
          id: id('msg'),
          type: 'message',
          role: 'assistant',
          model: body.model || 'claude-sonnet-5',
          content: [{ type: 'text', text: report }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 420, output_tokens: 380 },
        },
      ];
    },
  },

  // --- QuickBooks: invoice (step 11) ---------------------------------------
  {
    method: 'POST',
    match: /^\/quickbooks\/v3\/company\/([^/]+)\/invoice$/,
    handler: (body) => {
      const num = 1000 + store.invoices.size + 1;
      const invoice = {
        Id: String(num),
        DocNumber: `INV-${num}`,
        TotalAmt: body.Line?.reduce((s, l) => s + (l.Amount || 0), 0) || 0,
        Balance: body.Line?.reduce((s, l) => s + (l.Amount || 0), 0) || 0,
        CustomerRef: body.CustomerRef,
        TxnDate: new Date().toISOString().slice(0, 10),
        Line: body.Line || [],
      };
      store.invoices.set(invoice.Id, invoice);
      log('quickbooks', 'invoice.created', {
        summary: `${invoice.DocNumber} for $${invoice.TotalAmt.toFixed(2)}`,
        invoiceId: invoice.Id,
      });
      return [200, { Invoice: invoice, time: new Date().toISOString() }];
    },
  },
  {
    method: 'POST',
    match: /^\/quickbooks\/v3\/company\/([^/]+)\/invoice\/([^/]+)\/send$/,
    handler: (_body, [, invoiceId]) => {
      log('quickbooks', 'invoice.emailed', { summary: `invoice ${invoiceId} sent to customer` });
      return [200, { Invoice: store.invoices.get(invoiceId) || { Id: invoiceId } }];
    },
  },
];

/**
 * Nearest-neighbour ordering, used by the mock Routes API.
 * The real Google Routes API does proper optimization; this only needs to be
 * plausible and deterministic.
 */
function nearestNeighbourOrder(origin, waypoints) {
  const pts = waypoints.map((w, i) => ({
    i,
    lat: w.location?.latLng?.latitude ?? 0,
    lng: w.location?.latLng?.longitude ?? 0,
  }));
  const order = [];
  let cur = { lat: origin.latitude, lng: origin.longitude };
  const remaining = [...pts];

  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    remaining.forEach((p, idx) => {
      const d = (p.lat - cur.lat) ** 2 + (p.lng - cur.lng) ** 2;
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    });
    const [chosen] = remaining.splice(best, 1);
    order.push(chosen.i);
    cur = chosen;
  }
  return order;
}

/** A plausible Claude-style job report, derived from whatever notes came in. */
function mockReport(prompt) {
  const notes = (prompt.match(/notes["\s:]+([^"]{0,400})/i) || [])[1] || 'work completed';
  return [
    '## Summary of Work Completed',
    '',
    `Our technician attended the property and completed the scheduled service. ${notes.trim()}`,
    '',
    '## What We Found',
    '',
    'On inspection, the reported fault was confirmed. The affected components were',
    'assessed for wear and the surrounding pipework was checked for secondary damage.',
    '',
    '## What We Did',
    '',
    '- Isolated the water supply to the affected section',
    '- Replaced the failed component with a like-for-like part',
    '- Pressure-tested the repair and confirmed no ongoing leakage',
    '- Restored supply and verified normal operation at all nearby fixtures',
    '',
    '## Recommendations',
    '',
    'The repair is complete and no further action is required at this time. We',
    'recommend an annual inspection to catch similar wear before it fails.',
    '',
    '*This report was generated from the technician\'s on-site notes and photographs.*',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// HTTP plumbing (pun intended)
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5e6) req.destroy(); // basic guard
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch {
        // Twilio posts form-encoded, not JSON.
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, obj) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (req.method === 'OPTIONS') return send(204, {});

  // --- introspection -------------------------------------------------------
  if (url.pathname === '/__health') return send(200, { ok: true, calls: timeline.length });
  if (url.pathname === '/__timeline') return send(200, { calls: timeline });
  if (url.pathname === '/__reset') {
    timeline.length = 0;
    store.contacts.clear();
    store.opportunities.clear();
    store.invoices.clear();
    store.messages.length = 0;
    return send(200, { reset: true });
  }

  const body = await readBody(req);

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const m = url.pathname.match(route.match);
    if (!m) continue;
    try {
      const [code, payload] = route.handler(body, m.slice(1), url);
      return send(code, payload);
    } catch (err) {
      console.error('mock handler error:', err);
      return send(500, { error: err.message });
    }
  }

  return send(404, {
    error: 'no mock route',
    method: req.method,
    path: url.pathname,
    hint: 'Add a handler in mock/server.js if a workflow needs this endpoint.',
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`mock vendor server listening on http://localhost:${PORT}`);
    console.log('  timeline: /__timeline   reset: /__reset   health: /__health');
  });
}

module.exports = { server, timeline, store, fakeGeocode, nearestNeighbourOrder };
