# Going Live

`MOCK_MODE=false` is the switch. After that, texts go to real phones and
invoices to real customers.

Work through the accounts in this order — the first one has a 1–3 week lead
time and blocks everything else.

---

## 0. Before anything: A2P 10DLC

Read `docs/COMPLIANCE.md` and start the registration **now**. It takes 1–3
weeks. Unregistered SMS is silently filtered by the carriers, so this is not a
step you can defer to launch week.

---

## 1. Twilio — SMS

1. Buy a local number in the client's area code.
2. Complete A2P 10DLC (step 0) and attach the number to the campaign.
3. Copy the Account SID and Auth Token into `.env`:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM_NUMBER=+15125550100
```

4. **Point the inbound webhook at workflow 04.** In the number's Messaging
   settings, set "A message comes in" to:

```
https://<your-public-url>/webhook/sms-inbound
```

Without this, replies go nowhere and nothing is ever confirmed.

### You need a public URL

Twilio has to reach your n8n instance from the internet. `localhost` will not
do. Either:

- **Development:** `ngrok http 5678`, then set `WEBHOOK_URL` to the ngrok URL
  and restart n8n. Free, but the URL changes every restart.
- **Production:** host n8n on a small VPS (a $6/month box is plenty) behind a
  real domain with HTTPS. Set `WEBHOOK_URL` to that domain.

Whatever you choose, `WEBHOOK_URL` in `.env` must match, because n8n builds its
webhook URLs from it.

---

## 2. GoHighLevel — CRM

1. **Settings → Private Integrations → Create.** Scopes needed:
   `contacts.write`, `opportunities.write`, `locations.readonly`.
2. Copy the token and the Location ID.
3. Create the pipeline the automation moves cards through — stages **Booked**,
   **Confirmed**, **Completed** — and copy each stage id from the URL when you
   open it.

```bash
GHL_API_KEY=pit-xxxxxxxx
GHL_LOCATION_ID=xxxxxxxx
GHL_PIPELINE_ID=xxxxxxxx
GHL_STAGE_BOOKED_ID=xxxxxxxx
GHL_STAGE_CONFIRMED_ID=xxxxxxxx
GHL_STAGE_COMPLETED_ID=xxxxxxxx
```

### One thing to check

The nurture steps call `enrollInCampaign(contactId, 'declined_reactivation')`
and `'post_job_maintenance'`. Create workflows in GoHighLevel with matching
names, or change the names in `lib/services.js`. GHL's campaign API surface
varies by account age — if enrolment 404s, the fallback is to tag the contact
(the code already tags) and trigger the GHL workflow off the tag instead. That
is often simpler anyway.

---

## 3. Email

Either a provider API key or plain SMTP.

```bash
SENDGRID_API_KEY=SG.xxxxxxxx
# or
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=xxx
SMTP_PASS=xxx
```

**Set up SPF, DKIM and DMARC on the client's domain.** Transactional email from
an unauthenticated domain lands in spam, and the job report and invoice both
travel by email. Whichever provider you pick will walk you through the DNS
records.

---

## 4. Google Maps

1. Google Cloud Console → create a project.
2. Enable **Routes API** and **Geocoding API**.
3. Create an API key and **restrict it** to those two APIs plus your server's
   IP. An unrestricted key that leaks gets used by strangers at your expense.

```bash
GOOGLE_MAPS_API_KEY=AIzaxxxxxxxx
```

The free tier covers a single plumber comfortably. Set a billing alert anyway.

---

## 5. Claude — the job report

1. console.anthropic.com → API keys.

```bash
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
ANTHROPIC_MODEL=claude-sonnet-5
```

A report costs well under a cent. Sonnet is the right choice here: fast, cheap,
and this is straightforward writing from supplied notes.

The prompt in `lib/services.js` explicitly tells it not to invent facts the
notes do not contain. Read a few of the first real reports before letting them
go out unattended — the plumber's notes vary in quality far more than test data
suggests, and it is worth seeing what the model does with a terse one.

---

## 6. QuickBooks Online

The fiddliest of the six, because it is OAuth2 rather than a static key.

1. developer.intuit.com → create an app.
2. Get a refresh token through the OAuth Playground (Intuit's own tool).
3. Copy the Realm ID (your client's company id) from the playground.

```bash
QBO_CLIENT_ID=xxxxxxxx
QBO_CLIENT_SECRET=xxxxxxxx
QBO_REFRESH_TOKEN=xxxxxxxx
QBO_REALM_ID=xxxxxxxx
QBO_ENVIRONMENT=sandbox     # switch to production when tested
```

### Two things to sort before real invoices

**Refresh tokens expire after 100 days.** `lib/services.js` uses the token
directly. Before production, add a step that exchanges the refresh token for an
access token and stores the rotated refresh token. If you skip this, invoicing
silently stops three months in — long after you have moved on, and exactly the
kind of failure that loses a retainer.

**Customer matching.** The code passes the GHL contact id as `customerRef`.
QuickBooks needs its own customer id. Either create QuickBooks customers as part
of workflow 01, or look them up by email before invoicing. Decide this before
the first real invoice, not after.

**Test in sandbox first.** Run several jobs end to end in `sandbox` and check
the invoices look right before switching to `production`.

---

## 7. Flip the switch

```bash
# in .env
MOCK_MODE=false
```

```bash
docker compose restart n8n
```

---

## First live job: watch it

Do not walk away. Book a real appointment using your own phone and email, and
check each one:

- [ ] Confirmation SMS arrives, correctly branded, correct time
- [ ] Confirmation email arrives in the inbox, not spam
- [ ] The contact and opportunity appear in GoHighLevel
- [ ] The assigned partner gets their dispatch text
- [ ] Wait for the T-24 SMS (or move the appointment to force it)
- [ ] Reply **YES** → confirmed, CRM card moves
- [ ] Reply **STOP** from a second number → opt-out confirmation, nothing after
- [ ] The evening route email arrives with the right stops in a sensible order
- [ ] "On my way" texts an ETA that is roughly true
- [ ] Submit job notes → the report reads well
- [ ] The invoice appears in QuickBooks with the right amount
- [ ] The feedback email arrives; clicking 5 gets the thank-you and review link
- [ ] Click 2 on a second test job → owner callback task, **no review request**

That last one is the most important test in the list. A feedback automation
that asks unhappy customers for public reviews actively damages the business
you sold it to.

---

## When something breaks

**n8n → Executions** shows every run, the data at each node, and the error.
That is where you look first, always.

| Symptom | Usual cause |
|---|---|
| Booking form says "could not reach" | Workflow 01 is not Active, or the URL is wrong |
| SMS never arrives | A2P registration incomplete, or the number isn't on the campaign |
| Replies do nothing | Twilio's inbound webhook isn't pointed at `/webhook/sms-inbound` |
| Everything 500s at a Postgres node | The credential isn't named exactly `Plumber Postgres` |
| A `{{ }}` appears literally in an error | An expression is missing its `=` prefix — run `node scripts/build-workflows.js`, which now catches this |
| Route email is empty | No jobs reached `confirmed` — check workflow 04 is Active |
| Invoicing stopped after ~3 months | The QuickBooks refresh token expired (see section 6) |

### Rolling back

`MOCK_MODE=true` and restart. Everything keeps running; nothing reaches a real
customer. Safe at any time.
