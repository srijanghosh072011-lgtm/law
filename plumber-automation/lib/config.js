'use strict';

/**
 * Endpoint resolution — the one place MOCK_MODE is honoured.
 *
 * Every workflow builds its URLs through here. That is what makes the mock
 * switch a one-line change: with MOCK_MODE=true all five external services
 * resolve to the local mock server, with MOCK_MODE=false they resolve to the
 * real vendors. No workflow node hardcodes a hostname.
 */

const LIVE = {
  ghl:        'https://services.leadconnectorhq.com',
  twilio:     'https://api.twilio.com',
  quickbooks_sandbox:    'https://sandbox-quickbooks.api.intuit.com',
  quickbooks_production: 'https://quickbooks.api.intuit.com',
  maps:       'https://routes.googleapis.com',
  geocode:    'https://maps.googleapis.com',
  anthropic:  'https://api.anthropic.com',
  email:      'https://api.sendgrid.com',
};

function isMock(env = process.env) {
  // Anything other than an explicit "false" stays mocked. Defaulting to safe
  // means a missing or misspelled env var can never text a real customer.
  return String(env.MOCK_MODE ?? 'true').toLowerCase() !== 'false';
}

/**
 * @param {object} env  normally process.env, or $env inside an n8n Code node.
 * @returns {object} base URLs keyed by service.
 */
function endpoints(env = process.env) {
  const mockBase = env.MOCK_BASE_URL || 'http://mock:4000';

  if (isMock(env)) {
    return {
      mock: true,
      ghl:       `${mockBase}/ghl`,
      twilio:    `${mockBase}/twilio`,
      quickbooks:`${mockBase}/quickbooks`,
      maps:      `${mockBase}/maps`,
      geocode:   `${mockBase}/maps`,
      anthropic: `${mockBase}/anthropic`,
      email:     `${mockBase}/email`,
    };
  }

  const qbo =
    env.QBO_ENVIRONMENT === 'production'
      ? LIVE.quickbooks_production
      : LIVE.quickbooks_sandbox;

  return {
    mock: false,
    ghl: LIVE.ghl,
    twilio: LIVE.twilio,
    quickbooks: qbo,
    maps: LIVE.maps,
    geocode: LIVE.geocode,
    anthropic: LIVE.anthropic,
    email: LIVE.email,
  };
}

/** Business identity + messaging settings, with sane defaults for demos. */
function business(env = process.env) {
  return {
    name:        env.BUSINESS_NAME || 'Rapid Response Plumbing',
    phone:       env.BUSINESS_PHONE || '+15125550100',
    email:       env.BUSINESS_EMAIL || 'dispatch@example-plumbing.com',
    timezone:    env.BUSINESS_TIMEZONE || 'America/Chicago',
    bookingUrl:  env.BOOKING_URL || 'http://localhost:8080/booking.html',
    reviewUrl:   env.GOOGLE_REVIEW_URL || 'https://g.page/r/EXAMPLE/review',
    quietHours: {
      start: Number(env.QUIET_HOURS_START ?? 21),
      end:   Number(env.QUIET_HOURS_END ?? 8),
    },
  };
}

module.exports = { endpoints, business, isMock, LIVE };
