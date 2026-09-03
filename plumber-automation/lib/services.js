'use strict';

/**
 * Vendor clients.
 *
 * One function per external call the automation makes. Every one routes through
 * config.endpoints(), so MOCK_MODE decides whether it hits the local mock or
 * the real vendor — no caller ever knows or cares which.
 *
 * WHY THIS FILE EXISTS AT ALL (rather than n8n HTTP Request nodes):
 * putting the calls here means they are unit-testable, reviewable in a diff,
 * and reusable for the next client you sell this to. The n8n workflows stay
 * thin — triggers, branching and scheduling — which is what n8n is genuinely
 * good at. See docs/ARCHITECTURE.md.
 *
 * Uses Node 22's built-in fetch. No dependencies.
 */

const { endpoints, isMock } = require('./config.js');

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * fetch with a timeout and a useful error message.
 * A vendor that hangs must not hang the whole workflow execution.
 */
async function request(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();

    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(
        `${options.method || 'GET'} ${url} failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`
      );
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${options.method || 'GET'} ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const json = (body) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

// ===========================================================================
// GoHighLevel — spec step 2
// ===========================================================================
function ghl(env = process.env) {
  const base = endpoints(env).ghl;
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${env.GHL_API_KEY || 'mock-token'}`,
    Version: '2021-07-28',
  };

  return {
    /** Create or update the contact. Upsert, so repeat customers stay one record. */
    async upsertContact(customer) {
      const [firstName, ...rest] = String(customer.full_name || '').split(' ');
      const res = await request(`${base}/contacts/upsert`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          locationId: env.GHL_LOCATION_ID || 'mock-location',
          firstName,
          lastName: rest.join(' '),
          email: customer.email,
          phone: customer.phone,
          address1: customer.address_line,
          city: customer.city,
          state: customer.state,
          postalCode: customer.postal_code,
          source: 'Website booking form',
        }),
      });
      return res.contact;
    },

    /** The job as a pipeline opportunity, so the owner sees it on their board. */
    async createOpportunity({ contactId, name, value, stageId }) {
      const res = await request(`${base}/opportunities`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          locationId: env.GHL_LOCATION_ID || 'mock-location',
          pipelineId: env.GHL_PIPELINE_ID || 'mock-pipeline',
          pipelineStageId: stageId || env.GHL_STAGE_BOOKED_ID || 'booked',
          contactId,
          name,
          monetaryValue: value ?? 0,
          status: 'open',
        }),
      });
      return res.opportunity;
    },

    async moveOpportunity(opportunityId, stageId, status = 'open') {
      const res = await request(`${base}/opportunities/${opportunityId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ pipelineStageId: stageId, status }),
      });
      return res.opportunity;
    },

    async tagContact(contactId, tags) {
      return request(`${base}/contacts/${contactId}/tags`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tags }),
      });
    },

    /** Nurture + reactivation — spec steps 6 and 15. */
    async enrollInCampaign(contactId, campaign) {
      return request(`${base}/campaigns/${encodeURIComponent(campaign)}/enroll`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contactId }),
      });
    },
  };
}

// ===========================================================================
// Twilio — SMS. Spec steps 1, 4, 9.
// ===========================================================================
function twilio(env = process.env) {
  const base = endpoints(env).twilio;
  const sid = env.TWILIO_ACCOUNT_SID || 'ACmock';

  return {
    async sendSms({ to, body, from }) {
      const params = new URLSearchParams({
        To: to,
        From: from || env.TWILIO_FROM_NUMBER || env.BUSINESS_PHONE || '+15125550100',
        Body: body,
      });

      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      // The real API needs basic auth; the mock ignores it.
      if (!isMock(env) && env.TWILIO_AUTH_TOKEN) {
        headers.Authorization =
          'Basic ' + Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
      }

      return request(`${base}/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers,
        body: params.toString(),
      });
    },
  };
}

// ===========================================================================
// Email — spec steps 1, 10, 12, 14. SendGrid's v3 shape.
// ===========================================================================
function email(env = process.env) {
  const base = endpoints(env).email;

  return {
    async send({ to, subject, html, text }) {
      return request(`${base}/v3/mail/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${env.SENDGRID_API_KEY || 'mock-key'}`,
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }], subject }],
          from: {
            email: env.BUSINESS_EMAIL || 'dispatch@example-plumbing.com',
            name: env.BUSINESS_NAME || 'Rapid Response Plumbing',
          },
          subject,
          content: [
            { type: 'text/plain', value: text || stripHtml(html || '') },
            ...(html ? [{ type: 'text/html', value: html }] : []),
          ],
        }),
      });
    },
  };
}

const stripHtml = (s) => String(s).replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

// ===========================================================================
// Google Maps — geocoding, route optimization, ETA. Spec steps 8, 9.
// ===========================================================================
function maps(env = process.env) {
  const eps = endpoints(env);

  return {
    /** Address -> coordinates. Needed before any distance maths. */
    async geocode(address) {
      if (isMock(env)) {
        const res = await request(`${eps.geocode}/geocode`, {
          method: 'POST',
          ...json({ address }),
        });
        return res.results[0].geometry.location;
      }
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('address', address);
      url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);
      const res = await request(url.toString());
      if (!res.results?.length) throw new Error(`geocode found nothing for "${address}"`);
      return res.results[0].geometry.location;
    },

    /**
     * Optimized stop order for a day's route.
     * `origin` and each stop are {lat, lng}. Returns Google's
     * optimizedIntermediateWaypointIndex — the stops in the order to drive them.
     */
    async optimizeRoute({ origin, stops }) {
      const payload = {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        intermediates: stops.map((s) => ({
          location: { latLng: { latitude: s.lat, longitude: s.lng } },
        })),
        travelMode: 'DRIVE',
        optimizeWaypointOrder: true,
        routingPreference: 'TRAFFIC_AWARE',
      };

      const headers = { 'content-type': 'application/json' };
      if (!isMock(env)) {
        headers['X-Goog-Api-Key'] = env.GOOGLE_MAPS_API_KEY;
        headers['X-Goog-FieldMask'] =
          'routes.optimizedIntermediateWaypointIndex,routes.distanceMeters,routes.duration,routes.legs.distanceMeters,routes.legs.duration';
      }

      const res = await request(`${eps.maps}/directions/v2:computeRoutes`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      return res.routes[0];
    },

    /** Live ETA for the "on my way" text. */
    async eta({ from, destination }) {
      if (isMock(env)) {
        const res = await request(`${eps.maps}/eta`, {
          method: 'POST',
          ...json({ from, destination }),
        });
        return res;
      }
      const route = await this.optimizeRoute({ origin: from, stops: [destination] });
      const seconds = parseInt(route.duration, 10) || 0;
      return {
        durationMinutes: Math.max(1, Math.round(seconds / 60)),
        distanceMeters: route.distanceMeters,
      };
    },
  };
}

// ===========================================================================
// Claude — writes the post-job report. Spec step 10.
// ===========================================================================
function claude(env = process.env) {
  const base = endpoints(env).anthropic;

  return {
    async generateReport({ job, customer, partnerName, notes, photoCaptions = [] }) {
      const prompt = [
        'You are writing a job completion report for a plumbing customer.',
        'Write it FOR THE HOMEOWNER, not for the trade: plain language, no jargon,',
        'no invented facts. If the notes do not say something, do not claim it.',
        '',
        `Business: ${env.BUSINESS_NAME || 'the plumbing company'}`,
        `Technician: ${partnerName || 'our technician'}`,
        `Customer: ${customer?.full_name || 'the customer'}`,
        `Service address: ${customer?.address_line || 'n/a'}`,
        `Job type: ${job?.job_type || 'plumbing service'}`,
        `Original complaint: ${job?.description || 'n/a'}`,
        '',
        `Technician notes: ${notes}`,
        photoCaptions.length ? `Photos attached: ${photoCaptions.join('; ')}` : '',
        '',
        'Produce markdown with exactly these sections:',
        '## Summary of Work Completed',
        '## What We Found',
        '## What We Did',
        '## Recommendations',
        '',
        'Keep it under 350 words. Warm and professional. Do not include pricing.',
      ]
        .filter(Boolean)
        .join('\n');

      const res = await request(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY || 'mock-key',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
          max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      return res.content.map((c) => c.text).join('\n').trim();
    },
  };
}

// ===========================================================================
// QuickBooks Online — invoicing. Spec step 11.
// ===========================================================================
function quickbooks(env = process.env) {
  const base = endpoints(env).quickbooks;
  const realm = env.QBO_REALM_ID || 'mock-realm';

  const headers = () => ({
    'content-type': 'application/json',
    accept: 'application/json',
    Authorization: `Bearer ${env.QBO_ACCESS_TOKEN || env.QBO_REFRESH_TOKEN || 'mock-token'}`,
  });

  return {
    async createInvoice({ customerRef, customerEmail, lines }) {
      const res = await request(`${base}/v3/company/${realm}/invoice`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          CustomerRef: { value: customerRef },
          BillEmail: { Address: customerEmail },
          Line: lines.map((l) => ({
            DetailType: 'SalesItemLineDetail',
            Amount: l.amount,
            Description: l.description,
            SalesItemLineDetail: { Qty: l.qty ?? 1, UnitPrice: l.amount / (l.qty ?? 1) },
          })),
        }),
      });
      return res.Invoice;
    },

    /** QuickBooks emails the invoice itself — no template for us to maintain. */
    async sendInvoice(invoiceId, toEmail) {
      const url = new URL(`${base}/v3/company/${realm}/invoice/${invoiceId}/send`);
      if (toEmail) url.searchParams.set('sendTo', toEmail);
      const res = await request(url.toString(), { method: 'POST', headers: headers() });
      return res.Invoice;
    },
  };
}

/** Everything, wired to one env. This is what workflows and the demo import. */
function services(env = process.env) {
  return {
    ghl: ghl(env),
    twilio: twilio(env),
    email: email(env),
    maps: maps(env),
    claude: claude(env),
    quickbooks: quickbooks(env),
    mock: isMock(env),
  };
}

module.exports = { services, ghl, twilio, email, maps, claude, quickbooks, request };
