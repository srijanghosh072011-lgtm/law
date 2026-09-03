'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { keyFor, claim, record, release, once } = require('../lib/idempotency.js');

/**
 * A stand-in for Postgres that honours the one guarantee this module depends
 * on: INSERT ... ON CONFLICT DO NOTHING returns a row only for the first
 * insert of a given key.
 */
function fakeDb() {
  const rows = new Map();
  const calls = [];

  return {
    rows,
    calls,
    async query(sql, params) {
      calls.push(sql.trim().split(/\s+/)[0].toUpperCase());

      if (/^INSERT INTO idempotency_keys/i.test(sql.trim())) {
        const [key, jobId, step] = params;
        if (rows.has(key)) return { rows: [] };          // conflict -> no row
        rows.set(key, { key, job_id: jobId, step, response: null });
        return { rows: [{ key }] };
      }
      if (/^SELECT response/i.test(sql.trim())) {
        const row = rows.get(params[0]);
        return { rows: row ? [{ response: row.response }] : [] };
      }
      if (/^UPDATE idempotency_keys/i.test(sql.trim())) {
        const [key, response] = params;
        if (rows.has(key)) rows.get(key).response = response;
        return { rows: [] };
      }
      if (/^DELETE FROM idempotency_keys/i.test(sql.trim())) {
        const row = rows.get(params[0]);
        if (row && row.response === null) rows.delete(params[0]);
        return { rows: [] };
      }
      throw new Error('unexpected SQL: ' + sql);
    },
  };
}

test('keys are deterministic and namespaced by step', () => {
  assert.equal(keyFor('job-1', 'invoice'), 'job-1:invoice');
  assert.equal(keyFor('job-1', 'invoice'), keyFor('job-1', 'invoice'));
  assert.notEqual(keyFor('job-1', 'invoice'), keyFor('job-1', 'feedback_email'));
  assert.notEqual(keyFor('job-1', 'invoice'), keyFor('job-2', 'invoice'));
});

test('a discriminator lets a step legitimately repeat', () => {
  // Nurture touches fire on day 90 and again on day 180 — same job, same step,
  // and both must be allowed through.
  assert.notEqual(keyFor('job-1', 'nurture_touch', '90'), keyFor('job-1', 'nurture_touch', '180'));
});

test('keyFor refuses to build a key from missing inputs', () => {
  // A key of "undefined:invoice" would collide across every job in the system.
  assert.throws(() => keyFor(null, 'invoice'), /jobId is required/);
  assert.throws(() => keyFor('job-1', ''), /step is required/);
});

test('the first claim wins and the second is refused', async () => {
  const db = fakeDb();
  const first = await claim(db.query, { jobId: 'job-1', step: 'invoice' });
  const second = await claim(db.query, { jobId: 'job-1', step: 'invoice' });

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
});

test('a refused claim returns what the first attempt stored', async () => {
  const db = fakeDb();
  const { key } = await claim(db.query, { jobId: 'job-1', step: 'invoice' });
  await record(db.query, key, { invoiceId: 'INV-1001' });

  const second = await claim(db.query, { jobId: 'job-1', step: 'invoice' });
  assert.equal(second.claimed, false);
  assert.deepEqual(JSON.parse(second.response), { invoiceId: 'INV-1001' });
});

test('once() runs the work exactly once across repeated calls', async () => {
  // THE CORE GUARANTEE. n8n retrying a timed-out node must not create a
  // second invoice.
  const db = fakeDb();
  let invoicesCreated = 0;

  const createInvoice = async () => {
    invoicesCreated += 1;
    return { invoiceId: 'INV-' + invoicesCreated };
  };

  const a = await once(db.query, { jobId: 'job-1', step: 'quickbooks_invoice' }, createInvoice);
  const b = await once(db.query, { jobId: 'job-1', step: 'quickbooks_invoice' }, createInvoice);
  const c = await once(db.query, { jobId: 'job-1', step: 'quickbooks_invoice' }, createInvoice);

  assert.equal(invoicesCreated, 1, 'the vendor should have been called exactly once');
  assert.equal(a.skipped, false);
  assert.equal(b.skipped, true);
  assert.equal(c.skipped, true);
  assert.deepEqual(a.response, { invoiceId: 'INV-1' });
});

test('a failed call releases its claim so a real retry can succeed', async () => {
  // Without release(), one transient network blip would permanently mark the
  // invoice as sent and the customer would never be billed.
  const db = fakeDb();
  let attempts = 0;

  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('connection reset');
    return { invoiceId: 'INV-2001' };
  };

  await assert.rejects(
    () => once(db.query, { jobId: 'job-9', step: 'invoice' }, flaky),
    /connection reset/
  );

  const retry = await once(db.query, { jobId: 'job-9', step: 'invoice' }, flaky);
  assert.equal(retry.skipped, false);
  assert.deepEqual(retry.response, { invoiceId: 'INV-2001' });
  assert.equal(attempts, 2);
});

test('release does not undo a claim that already succeeded', async () => {
  const db = fakeDb();
  const { key } = await claim(db.query, { jobId: 'job-3', step: 'sms' });
  await record(db.query, key, { sid: 'SM123' });

  await release(db.query, key);   // must be a no-op: response is set

  const again = await claim(db.query, { jobId: 'job-3', step: 'sms' });
  assert.equal(again.claimed, false, 'a completed step must stay completed');
});

test('different steps on the same job are independent', async () => {
  const db = fakeDb();
  let sms = 0;
  let invoice = 0;

  await once(db.query, { jobId: 'job-4', step: 'sms' }, async () => { sms += 1; });
  await once(db.query, { jobId: 'job-4', step: 'invoice' }, async () => { invoice += 1; });
  await once(db.query, { jobId: 'job-4', step: 'sms' }, async () => { sms += 1; });

  assert.equal(sms, 1);
  assert.equal(invoice, 1);
});

test('concurrent claims on the same key yield exactly one winner', async () => {
  // Two n8n executions racing on the same job — e.g. a webhook delivered twice.
  const db = fakeDb();
  let ran = 0;

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      once(db.query, { jobId: 'job-5', step: 'confirmation' }, async () => {
        ran += 1;
        return { ok: true };
      })
    )
  );

  assert.equal(ran, 1);
  assert.equal(results.filter((r) => !r.skipped).length, 1);
});
