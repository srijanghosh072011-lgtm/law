# Plumber Booking Automation

End-to-end automation for a plumbing business: from a customer clicking **Book**
on the website through confirmation, dispatch, routing, arrival notice,
AI-written job report, invoice, feedback and long-term nurture — without the
plumber touching a keyboard.

Runs on **self-hosted n8n** (Community Edition — free, no operation limits).

---

## See it work in 30 seconds

No Docker, no database, no accounts, nothing to install:

```bash
cd plumber-automation
node scripts/demo.js
```

That walks one booking through all 15 steps against mock vendors and narrates
every decision. Try the other paths too:

```bash
node scripts/demo.js --decline            # says no, then no again -> nurture
node scripts/demo.js --unclear            # an ambiguous reply -> a human
node scripts/demo.js --negative-feedback  # unhappy customer -> callback, no review ask
node scripts/demo.js --no-consent         # rejected at the door
```

**This is the real logic**, not a mock-up of it — the demo calls the same
`lib/` modules the n8n workflows call. What it doesn't cover is n8n's own
triggers, scheduling and retries. For those, bring the stack up.

Run the test suite the same way:

```bash
node --test        # 117 tests, no dependencies to install
```

---

## What it does

Each numbered step is from the original brief.

| # | Step | Where it lives |
|---|------|----------------|
| 1 | Confirmation email + SMS on booking | `01-booking-intake` |
| 2 | Customer pushed into GoHighLevel | `01-booking-intake` |
| 3 | Job dispatched by location + skills | `02-partner-dispatch` |
| 4 | T-24 "reply YES or NO" SMS | `03-t24-confirmation` |
| 5 | They say no → reschedule sequence | `04-sms-inbound-router` |
| 6 | They say no again → nurture | `04-sms-inbound-router` |
| 7 | They say yes → confirmed | `04-sms-inbound-router` |
| 8 | Added to tomorrow's optimised route | `05-route-build` |
| 9 | Customer told when the plumber is coming | `06-on-my-way` |
| 10 | Claude writes the job report from notes + photos | `07-job-completion` |
| 11 | QuickBooks invoice raised and sent | `07-job-completion` |
| 12 | Feedback email | `07-job-completion` |
| 13 | Negative → task for the owner to call | `08-feedback-router` |
| 14 | Positive → thank-you, discount, review link | `08-feedback-router` |
| 15 | Everyone → nurture and reactivation | `09-nurture-reactivation` |

---

## Three things the original brief got wrong

Worth knowing before you sell this, because a client may ask.

**1. Step 7 was backwards.** The brief said that if the customer says *yes*, you
send the booking link again and they start over. Saying yes means confirmed —
that should lock the job in. The reschedule link belongs on *no*. Built the
sane way.

**2. Silence isn't handled at all.** The brief covers yes and no. In reality
roughly a third of people never reply. Here, silence gets its own path: one
nudge at T-12, then at T-3 the job is flagged and the plumber is told, so they
can ring ahead rather than drive to a house nobody confirmed. The van still
rolls — an unanswered text is not a cancellation.

**3. "GPS proximity" isn't what's built, and shouldn't be sold as such.**
Real proximity needs the plumber's phone broadcasting location in the
background: a driver app, battery drain, permission prompts and a per-driver
fee. Instead the plumber taps one button as they leave the previous job and we
send a live ETA. Same customer experience, no tracking infrastructure. When you
demo it, say *"one tap and the customer gets a live ETA"* — not *"GPS
tracking"*.

---

## Running the full stack

```bash
cp .env.example .env      # defaults are fine; MOCK_MODE=true means nothing real is sent
docker compose up -d
```

| What | Where |
|---|---|
| n8n editor | http://localhost:5678 |
| Booking form | http://localhost:8080/booking.html |
| Plumber's route | http://localhost:8080/on-my-way.html |
| Finish a job | http://localhost:8080/job-complete.html |
| Mock vendor log | http://localhost:4000/__timeline |

### Import the workflows

n8n does not auto-load them. In the editor: **Workflows → ⋯ → Import from
File**, once per file in `workflows/*.json`. Import them in numerical order so
that workflow 01's "Dispatch to Partner" node can find workflow 02.

### Add the Postgres credential

Workflows read and write job state through one shared credential.
**Credentials → New → Postgres**:

| Field | Value |
|---|---|
| Host | `postgres` |
| Database | `plumber` |
| User | `n8n` |
| Password | `n8n_local_dev` |
| Port | `5432` |

Name it exactly **Plumber Postgres** — the workflows reference it by that name.

### Activate

Toggle **Active** on each workflow. The webhook ones (01, 04, 06, 07, 08) start
listening; the cron ones (03, 05, 09) start on their schedule.

Then open the booking form and submit it. Watch `/__timeline` fill up.

---

## How it's put together

```
web/*.html          the three pages people touch
    |
    v
n8n workflows       triggers, branching, scheduling, retries
    |
    v
lib/*.js            all the actual logic — unit tested
    |
    v
mock/server.js      stands in for every vendor while MOCK_MODE=true
```

**Why the logic is in `lib/` rather than inside n8n nodes.** Anything
interesting — partner scoring, SMS intent parsing, route ordering, compliance,
sentiment — is a plain JavaScript function with tests. That means you can change
a dispatch rule and know in one second whether you broke it, instead of clicking
through the editor firing test webhooks. It is also how you resell this to
plumber #2 without rebuilding it. n8n does what n8n is genuinely good at:
triggers, scheduling, retries, and a visual map the client can look at.

`docker-compose.yml` mounts `./lib` into the n8n container at `/home/node/lib`,
which is why the Code nodes can `require('/home/node/lib/...')`.

### The library

| File | What it handles |
|---|---|
| `validation.js` | Booking payloads. E.164 phone normalisation, DST-aware local times, consent. |
| `partner-scoring.js` | Who gets the job. Hard filters, then weighted ranking. |
| `sms-parser.js` | What the customer's text actually meant. |
| `reply-routing.js` | Which branch that reply takes. |
| `compliance.js` | Opt-outs, quiet hours, segment costs. Gates every SMS. |
| `route-optimizer.js` | Tomorrow's driving order. |
| `sentiment.js` | Feedback classification and what to do about it. |
| `idempotency.js` | Stops a retry from double-invoicing. |
| `templates.js` | Every customer-facing message. Rebrand here. |
| `services.js` | The vendor API calls. |
| `config.js` | The one place `MOCK_MODE` is honoured. |

### Editing a workflow

Workflows are generated from readable sources:

```bash
# edit workflows/src/03-t24-confirmation.js, then
node scripts/build-workflows.js
```

Commit both the `.js` and the regenerated `.json`. The build validates that
every connection points at a node that exists, and that every `{{ }}` expression
carries the `=` prefix n8n requires — without it n8n sends the placeholder text
straight to Postgres.

You can also edit in the n8n UI and export back over the `.json`, but then the
`src/` file is stale. Pick one direction and stick to it.

---

## Going live

`MOCK_MODE=false` is the switch. **Read `docs/GOING-LIVE.md` before you flip
it** — after that, texts go to real phones and invoices to real customers.

`docs/COMPLIANCE.md` covers the part that is easy to skip and expensive to get
wrong: US business SMS requires **A2P 10DLC registration**, and unregistered
traffic gets silently filtered by the carriers. Your client would be paying for
an automation whose texts quietly stop arriving.

---

## Cost to run

| | Mock mode | Live, ~100 jobs/month |
|---|---|---|
| n8n Community, self-hosted | free | free |
| Postgres | free | free |
| Twilio | — | ~$1/mo number + ~$0.008/segment (~$5) + 10DLC fees |
| Google Maps | — | free tier covers this easily |
| Claude (`claude-sonnet-5`) | — | well under $1 for 100 reports |
| GoHighLevel, QuickBooks | — | the client already pays for these |

One job makes about **20 vendor calls** end to end. That number is why this runs
on n8n rather than Make.com: Make's free tier is 1,000 operations a month, so
you would hit the ceiling at roughly 50 jobs and be pushed onto a paid plan.
n8n Community has no such limit.
