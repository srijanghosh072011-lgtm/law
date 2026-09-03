-- Plumber Booking Automation — job state store
--
-- n8n holds workflow definitions, not business data. This schema is where a job
-- actually lives between the workflows: intake writes it, the T-24 cron reads it,
-- the route builder orders it, and the completion flow closes it out.
--
-- Applied automatically on first `docker compose up` (see docker-compose.yml).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ghl_contact_id  TEXT UNIQUE,               -- populated by workflow 01
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT NOT NULL,             -- always stored E.164: +15125551234
    address_line    TEXT NOT NULL,
    city            TEXT,
    state           TEXT,
    postal_code     TEXT,
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,
    -- Proof of SMS consent. Without these three columns you cannot defend a TCPA
    -- complaint, and A2P 10DLC registration asks you to describe how you collect it.
    sms_consent           BOOLEAN NOT NULL DEFAULT FALSE,
    sms_consent_at        TIMESTAMPTZ,
    sms_consent_source    TEXT,                -- e.g. 'booking_form_v1'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (email);

-- ---------------------------------------------------------------------------
-- Partners (the plumbers / subcontractors jobs get dispatched to)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partners (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT NOT NULL,
    -- Home base, used as the route start/end and for distance scoring.
    base_lat        DOUBLE PRECISION NOT NULL,
    base_lng        DOUBLE PRECISION NOT NULL,
    service_radius_km  DOUBLE PRECISION NOT NULL DEFAULT 40,
    skills          TEXT[] NOT NULL DEFAULT '{}',   -- e.g. {water_heater,gas_line}
    max_jobs_per_day   INTEGER NOT NULL DEFAULT 6,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Jobs — the central record
-- ---------------------------------------------------------------------------
-- status transitions:
--   booked -> assigned -> confirmed -> routed -> en_route -> completed -> invoiced -> closed
--   any    -> rescheduling -> booked        (customer said no, 1st time)
--   any    -> nurture                       (customer said no, 2nd time)
--   any    -> unconfirmed                   (customer never replied)
--   any    -> cancelled
CREATE TABLE IF NOT EXISTS jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    partner_id          UUID REFERENCES partners (id) ON DELETE SET NULL,

    job_type            TEXT NOT NULL,          -- water_heater, leak_repair, ...
    description         TEXT,
    urgency             TEXT NOT NULL DEFAULT 'standard',  -- emergency|standard|flexible

    scheduled_start     TIMESTAMPTZ NOT NULL,
    scheduled_end       TIMESTAMPTZ,
    timezone            TEXT NOT NULL DEFAULT 'America/Chicago',

    status              TEXT NOT NULL DEFAULT 'booked',

    -- Confirmation loop bookkeeping (workflows 03 + 04).
    confirm_sent_at         TIMESTAMPTZ,
    confirm_response        TEXT,               -- YES|NO|STOP|UNCLEAR
    confirm_responded_at    TIMESTAMPTZ,
    decline_count           INTEGER NOT NULL DEFAULT 0,   -- 1st no -> reschedule, 2nd -> nurture
    nudge_sent_at           TIMESTAMPTZ,

    -- Delivery + billing.
    ghl_opportunity_id  TEXT,
    quickbooks_invoice_id TEXT,
    report_url          TEXT,
    amount_cents        INTEGER,

    -- Feedback loop (workflow 08).
    feedback_rating     INTEGER,                -- 1-5
    feedback_text       TEXT,
    feedback_sentiment  TEXT,                   -- positive|negative|neutral

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status          ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_start ON jobs (scheduled_start);
CREATE INDEX IF NOT EXISTS idx_jobs_customer        ON jobs (customer_id);
-- The T-24 cron's exact query shape: "jobs starting in the next window, not yet asked".
CREATE INDEX IF NOT EXISTS idx_jobs_confirm_due
    ON jobs (scheduled_start)
    WHERE status IN ('assigned', 'booked') AND confirm_sent_at IS NULL;

-- ---------------------------------------------------------------------------
-- Route stops — one row per confirmed job placed into a day's route
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_stops (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    partner_id      UUID NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
    route_date      DATE NOT NULL,
    stop_order      INTEGER NOT NULL,           -- 1-based, as optimized
    eta             TIMESTAMPTZ,
    drive_seconds   INTEGER,                    -- from previous stop
    distance_meters INTEGER,
    on_my_way_at    TIMESTAMPTZ,                -- set when the plumber taps the button
    arrived_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, route_date),
    UNIQUE (partner_id, route_date, stop_order)
);

CREATE INDEX IF NOT EXISTS idx_route_stops_lookup ON route_stops (partner_id, route_date, stop_order);

-- ---------------------------------------------------------------------------
-- Messages — every SMS and email in or out
-- ---------------------------------------------------------------------------
-- Doubles as the audit trail you show a client who says "we never got a text".
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID REFERENCES jobs (id) ON DELETE SET NULL,
    customer_id     UUID REFERENCES customers (id) ON DELETE SET NULL,
    channel         TEXT NOT NULL,              -- sms|email
    direction       TEXT NOT NULL,              -- outbound|inbound
    template        TEXT,                       -- booking_confirmation, t24_confirm, ...
    to_addr         TEXT NOT NULL,
    body            TEXT NOT NULL,
    provider_id     TEXT,                       -- Twilio SID / email message id
    status          TEXT NOT NULL DEFAULT 'sent',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_job ON messages (job_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- SMS opt-outs — honoured before every single outbound SMS
-- ---------------------------------------------------------------------------
-- Kept separate from customers on purpose: a STOP is tied to a phone number, and
-- must survive the customer record being deleted, merged, or re-created.
CREATE TABLE IF NOT EXISTS sms_optouts (
    phone       TEXT PRIMARY KEY,
    opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason      TEXT NOT NULL DEFAULT 'STOP'
);

-- ---------------------------------------------------------------------------
-- Idempotency — the thing that stops a retry from double-invoicing
-- ---------------------------------------------------------------------------
-- n8n retries a failed HTTP node. Without this table, a QuickBooks call that
-- timed out *after* creating the invoice creates a second invoice on retry.
-- Every external write claims a key here first; a duplicate claim returns the
-- stored response instead of calling out again.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key             TEXT PRIMARY KEY,           -- "<job_id>:<step_name>"
    job_id          UUID,
    step            TEXT NOT NULL,
    response        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Nurture enrollments (workflow 09)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nurture_enrollments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    job_id          UUID REFERENCES jobs (id) ON DELETE SET NULL,
    campaign        TEXT NOT NULL,              -- declined_reactivation | post_job_maintenance
    enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_touch_at   TIMESTAMPTZ NOT NULL,
    touches_sent    INTEGER NOT NULL DEFAULT 0,
    completed       BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (customer_id, campaign)
);

CREATE INDEX IF NOT EXISTS idx_nurture_due ON nurture_enrollments (next_touch_at) WHERE completed = FALSE;

-- ---------------------------------------------------------------------------
-- Tasks for the business owner (workflow 08, negative feedback path)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS owner_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID REFERENCES jobs (id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    detail          TEXT,
    priority        TEXT NOT NULL DEFAULT 'normal',  -- urgent|normal
    due_at          TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated ON jobs;
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_customers_updated ON customers;
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
