'use strict';

/**
 * Idempotency guard — the most important 60 lines in this project.
 *
 * THE PROBLEM
 * n8n retries a failed HTTP node. But "failed" from n8n's point of view often
 * means "I did not get a response in time" — not "nothing happened". A
 * QuickBooks call that times out *after* the invoice was created looks
 * identical to one that never landed. Retry it and the customer gets two
 * invoices. The same failure mode double-texts, double-emails and
 * double-charges.
 *
 * THE FIX
 * Before any external write, claim a key derived from (job, step). The claim is
 * an atomic INSERT: whoever inserts the row first owns the work. A second
 * attempt finds the row already there, gets `claimed: false`, and returns the
 * stored response instead of calling the vendor again.
 *
 * This module holds no database driver on purpose — you pass in a query
 * function. That keeps it unit-testable with a fake, and usable from both the
 * mock server and n8n Postgres nodes.
 */

/**
 * Build the key for a step. Deterministic: the same job and step always
 * produce the same key, which is exactly what makes the guard work.
 *
 * @param {string} jobId
 * @param {string} step  e.g. 'booking_confirmation_sms', 'quickbooks_invoice'
 * @param {string} [discriminator]  for steps that legitimately repeat, such as
 *   a nurture touch that fires on day 90 and again on day 180.
 */
function keyFor(jobId, step, discriminator) {
  if (!jobId) throw new Error('idempotency.keyFor: jobId is required');
  if (!step) throw new Error('idempotency.keyFor: step is required');
  return discriminator ? `${jobId}:${step}:${discriminator}` : `${jobId}:${step}`;
}

/**
 * Attempt to claim a step.
 *
 * @param {function} query  async (sql, params) => ({ rows: [...] })
 * @param {object} opts  { jobId, step, discriminator }
 * @returns {Promise<{claimed: boolean, key: string, response: any}>}
 *   claimed:true  -> you own it, go make the external call.
 *   claimed:false -> someone already did it; `response` is what they got.
 */
async function claim(query, { jobId, step, discriminator } = {}) {
  const key = keyFor(jobId, step, discriminator);

  // ON CONFLICT DO NOTHING makes this atomic even with two n8n executions
  // racing on the same job — exactly one INSERT returns a row.
  const insert = await query(
    `INSERT INTO idempotency_keys (key, job_id, step)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, jobId, step]
  );

  if (insert.rows.length > 0) {
    return { claimed: true, key, response: null };
  }

  const existing = await query(
    `SELECT response FROM idempotency_keys WHERE key = $1`,
    [key]
  );

  return {
    claimed: false,
    key,
    response: existing.rows[0]?.response ?? null,
  };
}

/**
 * Record what the external call returned, so a later duplicate can be answered
 * without re-calling. Call this only after a successful claim + call.
 */
async function record(query, key, response) {
  await query(`UPDATE idempotency_keys SET response = $2 WHERE key = $1`, [
    key,
    JSON.stringify(response ?? null),
  ]);
  return response;
}

/**
 * Release a claim after the external call FAILED, so a genuine retry is
 * allowed to try again. Without this a transient network blip would
 * permanently mark the step as done and the customer would never get their
 * invoice.
 */
async function release(query, key) {
  await query(
    `DELETE FROM idempotency_keys WHERE key = $1 AND response IS NULL`,
    [key]
  );
}

/**
 * The whole pattern in one call: claim, run, record, release-on-failure.
 *
 * @param {function} query
 * @param {object} opts  { jobId, step, discriminator }
 * @param {function} fn  async () => response
 */
async function once(query, opts, fn) {
  const { claimed, key, response } = await claim(query, opts);

  if (!claimed) {
    return { skipped: true, key, response };
  }

  try {
    const result = await fn();
    await record(query, key, result);
    return { skipped: false, key, response: result };
  } catch (err) {
    await release(query, key);
    throw err;
  }
}

module.exports = { keyFor, claim, record, release, once };
