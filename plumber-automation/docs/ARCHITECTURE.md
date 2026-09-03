# Architecture

Why this is built the way it is. Short, because most of the reasoning lives in
comments next to the code it explains.

## The shape

```
web/*.html          three pages people touch: book, route, finish job
    |
    v
n8n workflows       triggers, branching, scheduling, retries, visual map
    |
    v
lib/*.js            all the logic — plain functions, unit tested
    |
    v
mock/server.js      every vendor, while MOCK_MODE=true
```

## Why the logic isn't in n8n nodes

The obvious way to build this is to do everything in n8n — Function nodes, IF
nodes, HTTP Request nodes. It demos well and it is a nightmare within a month.

- **You cannot test it.** Changing a dispatch rule means clicking through the
  editor and firing test webhooks. Here it is `node --test`, in one second.
- **You cannot review it.** A workflow diff is a wall of JSON with node ids in
  it. `lib/partner-scoring.js` reads like code.
- **You cannot resell it.** Plumber #2 has different skills and a different
  service area. That is a constant to change, not a rebuild.

So n8n does what it is genuinely good at — triggers, scheduling, retries, and a
picture the client can look at — and the logic lives in files.

`docker-compose.yml` mounts `./lib` into the container at `/home/node/lib`,
which is why Code nodes can `require('/home/node/lib/partner-scoring.js')`.

## Why nine workflows instead of one

A single sixty-node workflow fails as one unit: a broken QuickBooks call takes
the whole job down with it, and the execution log is unreadable. Small
workflows fail in isolation, can be re-run individually, and each fits on one
screen.

## Why crons instead of Wait nodes

Workflows 03, 05 and 09 are scheduled sweeps that ask "what is due now?" rather
than per-job timers.

An n8n Wait node holds an execution open for the duration. For a 24-hour
reminder that is a day; for a 365-day nurture touch it is a year. Every one of
them is lost when n8n restarts — and n8n restarts, for updates, deploys and
crashes. A cron reading state from the database survives restarts and backfills
anything it missed while down.

The `jobs` and `nurture_enrollments` rows are the state. The crons are stateless.

## Idempotency

`lib/idempotency.js` is the most important file here.

n8n retries a failed HTTP node. But "failed" usually means "no response in
time", which is indistinguishable from "it worked and the reply was lost". A
QuickBooks call that times out after creating the invoice looks exactly like one
that never landed. Retry it and the customer is billed twice.

Every external write claims a key of `job_id:step` first. The claim is an atomic
`INSERT ... ON CONFLICT DO NOTHING`, so exactly one caller wins even with two
executions racing. A failed call releases its claim so a genuine retry works;
a succeeded one stores the response, and a duplicate gets that instead of a
second vendor call.

## Failing forward

Where a later step can still deliver value, a failure does not abort the run.

The clearest case is workflow 07: if invoicing fails, throwing would stop the
workflow *before the node that releases the idempotency claim*, leaving the job
permanently marked as invoiced with no invoice in existence — the customer would
never be billed at all. So it records the error, lets the claim be released, and
still sends the report and the feedback request. The owner is emailed that a
completed job is unbilled.

The same pattern appears wherever a human can pick up the pieces: an
unassignable job, an unclear SMS reply, a job whose address won't geocode. None
of them fail silently, and none of them stop everything else.

## Mock-first

`MOCK_MODE` is honoured in exactly one place — `lib/config.js`. Every vendor
call resolves its base URL through it, so no workflow node hardcodes a hostname.

The mock returns the same response *shapes* as the real vendors, so field
mappings survive the switch to live. It has no npm dependencies, so
`node mock/server.js` works on a clean machine.

This is what makes `node scripts/demo.js` possible with nothing installed — and
being able to show a client the whole thing working before they have bought a
single subscription is worth more than it looks.
