# SMS Compliance

The part that is easy to skip and expensive to get wrong. Read it before you
flip `MOCK_MODE=false`.

This is a practical summary written by an engineer, not legal advice. If your
client operates at scale or in a strict state, have a lawyer look at it.

---

## The two things that will actually bite you

**1. A2P 10DLC registration.** Sending business SMS to US numbers from a normal
10-digit number requires registering the brand and the campaign with the
carriers. Unregistered traffic is not rejected loudly — it is **silently
filtered**. Your client pays $14,000 for an automation and their appointment
reminders quietly stop arriving. Nobody gets an error.

**2. The TCPA.** Texting someone who did not consent, or who opted out, carries
statutory damages of **$500–$1,500 per message**. An automation sending
hundreds of texts a month turns one configuration mistake into a five-figure
problem fast.

Everything below exists to handle those two.

---

## A2P 10DLC registration

Do this first — it takes 1–3 weeks and nothing else can go live without it.

1. **Register the Brand** in the Twilio console (Messaging → Regulatory
   Compliance → A2P 10DLC). Needs the client's legal business name, EIN,
   address and website. One-off fee, around $4.
2. **Register a Campaign.** Use case: **Mixed** or **Customer Care**. You will
   be asked for:
   - a description of the messages (appointment confirmations, reminders,
     arrival notices)
   - **two sample messages** — copy real ones from `lib/templates.js`
   - **how you collect consent** — point at the checkbox on the booking form
     and quote its exact wording
   - confirmation that you honour STOP and HELP
   Around $15 one-off plus ~$1.50–$10/month depending on throughput.
3. **Attach the number** to the campaign.

**The registration asks how you collect consent, and the answer must be true.**
That is why `web/booking.html` has an unticked, un-prefilled checkbox with
specific wording, and why `lib/validation.js` rejects a booking without it.
Those aren't decoration.

If the client is not a registered business, they cannot register a campaign and
cannot lawfully send business SMS at scale. That is a conversation to have
early, not after you have taken their money.

---

## Consent

The checkbox in `web/booking.html`:

> Text me about this appointment. I agree to receive appointment confirmations,
> reminders and arrival notices from Rapid Response Plumbing at the number
> above. Message and data rates may apply. Reply STOP to opt out at any time.

Rules it satisfies, all of which matter:

- **Not pre-ticked.** A pre-ticked box is not consent.
- **Names the business.** "We" is not identification.
- **Says what will be sent.** Appointment messages, not marketing.
- **Mentions rates and STOP.**
- **It is a hard requirement.** `validateBooking` returns an error rather than
  downgrading to email-only. A booking without consent is rejected, and the
  customer is told why.

Consent is stored with a timestamp and a source
(`sms_consent`, `sms_consent_at`, `sms_consent_source`). Without those three
columns you cannot answer a complaint.

---

## STOP, HELP, and the CANCEL trap

Carriers require that STOP and HELP always work. `lib/sms-parser.js` checks
them **first**, before any yes/no logic, so "yes but stop texting me" opts out
rather than confirming.

Twilio's default opt-out keywords are:

```
STOP  STOPALL  UNSUBSCRIBE  CANCEL  END  QUIT
```

### The one that surprises people

**`CANCEL` is an opt-out keyword.** A customer replying "cancel" meaning
*"cancel my appointment"* is unsubscribed from all future messages by Twilio —
before the text ever reaches this system. There is no code fix; the carrier
layer acts first.

What to do about it:

- Never write "reply CANCEL to cancel" in any message. The templates here don't.
- Phrase the confirmation as **"Reply YES to confirm or NO to reschedule"**, so
  nobody is nudged toward the word.
- Tell your client this will occasionally happen, and that such a customer must
  be contacted by phone until they text START.

`lib/compliance.js` treats an opt-out as absolute: it is checked before
everything else, and no message class overrides it.

---

## Quiet hours

Most US states restrict automated and marketing messages to 8am–9pm local.
`QUIET_HOURS_START` / `QUIET_HOURS_END` enforce it.

Two deliberate design choices:

**Blocked messages are deferred, not dropped.** A reminder held until 8am still
does its job; a dropped one is a missed appointment. The hourly cron in
workflow 03 simply picks it up again once the window opens.

**Transactional messages are exempt.** Someone who books an emergency call at
11pm expects a confirmation at 11pm, and an "on my way" text held until morning
is worthless. The exempt list is in `lib/compliance.js`:

```
booking_confirmation  partner_dispatch  on_my_way
help_response         stop_confirmation
```

Anything not on that list is treated as marketing — the safe default, so a new
template added later is quiet-hours bound until someone deliberately says
otherwise.

### One real limitation, stated plainly

Quiet hours use the **business** timezone, not the customer's. For a local
plumber serving one metro that is correct. If a client ever serves multiple
timezones this must change to a per-customer timezone resolved from their
address — otherwise you will text somebody at 6am. It is noted in the code at
`lib/compliance.js`.

---

## Message content

- **Every message names the business.** Unbranded messages are a common A2P
  rejection reason and get filtered in the wild.
- **The first message to a customer carries "Reply STOP to opt out."**
- **No marketing by SMS.** Nurture and reactivation are email-only, by design.
  Marketing texts are what destroy a number's sending reputation, and the
  appointment reminder is worth far more than the extra touch.

---

## Record keeping

The `messages` table logs every SMS and email, in and out, with the provider's
id. That is your answer when a customer says "I never got a text" — and your
evidence if a complaint is ever made.

`sms_optouts` is keyed on the phone number rather than the customer, on purpose:
an opt-out must survive the customer record being deleted, merged or recreated.

---

## Pre-launch checklist

- [ ] A2P 10DLC brand registered
- [ ] Campaign registered and approved
- [ ] Number attached to the campaign
- [ ] Consent checkbox live on the client's real booking form, unticked
- [ ] Consent wording matches what was submitted to the carriers
- [ ] STOP tested end to end on a real handset
- [ ] HELP tested end to end on a real handset
- [ ] `QUIET_HOURS_*` set to the client's actual timezone
- [ ] Client told about the CANCEL keyword behaviour
- [ ] Client understands nurture is email-only and why
