-- 0008_referral.sql — svc-referral: leads, routing, delivery, billing, disputes.
--
-- v2 non-negotiable #2 is the constraint that shapes this whole schema:
--
--   "Referral fees are flat and never contingent on case value, retention, or
--    attorney fees."
--
-- That is enforced structurally, not by policy. There is NO column anywhere in the
-- billing path for case value, recovery, settlement, or attorney fee. `damages_band`
-- exists on the lead because it is needed to ROUTE (an injury matter goes to a different
-- panel than a small claim) — but it lives on `leads`, and the fee is resolved from
-- `fee_schedule` by practice area and county alone. A contingent fee is not merely
-- disallowed here; there is nothing to compute one from.
--
-- Non-negotiable #3: a lead cannot be billed unless the not-already-represented check
-- passed. Enforced by CHECK, because "we meant to check" is how that rule gets skipped.

BEGIN;

CREATE TYPE lead_status AS ENUM (
  'draft',        -- being qualified during the call
  'qualified',    -- passed the gate, ready to route
  'routed',       -- matched to a recipient
  'delivered',    -- recipient acknowledged receipt
  'accepted',     -- recipient took it
  'declined',     -- recipient passed
  'disputed',     -- recipient says it was unqualified
  'credited',     -- dispute upheld, fee reversed
  'expired'       -- nobody took it in time
);

CREATE TYPE lead_recipient_kind AS ENUM (
  'attorney_network',        -- Ask Michael panel
  'incident_intelligence'    -- injury buyer network (v2 §2 rung 5)
);

-- Firms that receive leads. Kept minimal — the Ask Michael network is the system of
-- record; this is the routing and billing view of it.
CREATE TABLE lead_recipients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  kind          lead_recipient_kind NOT NULL DEFAULT 'attorney_network',
  name          TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  webhook_url   TEXT,
  stripe_customer_id TEXT UNIQUE,
  -- Leads per day this recipient will take. Routing respects it so a firm is not
  -- flooded and the lead is not wasted on someone who cannot work it.
  daily_capacity INTEGER NOT NULL DEFAULT 5 CHECK (daily_capacity >= 0),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which practice areas and counties a recipient covers.
CREATE TABLE lead_recipient_coverage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  UUID NOT NULL REFERENCES lead_recipients(id) ON DELETE CASCADE,
  practice_area TEXT NOT NULL,
  county        TEXT NOT NULL,
  state         CHAR(2) NOT NULL DEFAULT 'NC',
  UNIQUE (recipient_id, practice_area, county, state)
);

CREATE INDEX lead_recipient_coverage_lookup
  ON lead_recipient_coverage (practice_area, county, state);

-- The universal lead object (v2 §3).
--
-- Shaped so the cutover to the TRG Lead Exchange ingestion API is a config change: the
-- same columns serialise to the same JSON whether it lands here or is POSTed there.
CREATE TABLE leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  source_call_id        UUID REFERENCES calls(id) ON DELETE SET NULL,

  case_type             TEXT NOT NULL,
  practice_area         TEXT NOT NULL,
  county                TEXT NOT NULL,
  state                 CHAR(2) NOT NULL DEFAULT 'NC',

  -- Plain-language, guardrailed. Never a legal conclusion about the matter.
  summary               TEXT NOT NULL,
  qualification_answers JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Used for ROUTING only. Deliberately not reachable from the billing path.
  damages_band          TEXT,

  -- Contact details, released to the recipient only on acceptance.
  contact_name          TEXT,
  contact_phone         TEXT,
  contact_email         TEXT,

  -- v2 non-negotiable #3. A lead cannot bill without this having been asked and answered.
  not_already_represented BOOLEAN,
  represented_checked_at  TIMESTAMPTZ,

  -- v2 non-negotiable #4 + rung 5 disclosure, denormalised from call_consents so a
  -- delivered lead carries its own proof.
  consent_tcpa          BOOLEAN NOT NULL DEFAULT FALSE,
  consent_referral_disclosure BOOLEAN NOT NULL DEFAULT FALSE,
  consent_captured_at   TIMESTAMPTZ,

  status                lead_status NOT NULL DEFAULT 'draft',
  qualified_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Where it ultimately went, once the Lead Exchange exists.
  exchange_external_id  TEXT,

  CONSTRAINT qualified_leads_record_when
    CHECK (status = 'draft' OR qualified_at IS NOT NULL),

  -- Nothing past 'qualified' without the represented check and both consents.
  CONSTRAINT routable_leads_are_consented
    CHECK (
      status IN ('draft', 'qualified', 'expired')
      OR (not_already_represented IS TRUE
          AND consent_tcpa IS TRUE
          AND consent_referral_disclosure IS TRUE)
    )
);

CREATE INDEX leads_by_status ON leads (tenant_id, status, created_at DESC);
CREATE INDEX leads_by_call ON leads (source_call_id);
CREATE INDEX leads_routable ON leads (practice_area, county, state) WHERE status = 'qualified';

CREATE TABLE lead_deliveries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  recipient_id   UUID NOT NULL REFERENCES lead_recipients(id),
  channel        TEXT NOT NULL CHECK (channel IN ('webhook', 'email', 'sms', 'queue')),
  -- v2 §3: speed-to-lead target < 60 seconds. Measured, not assumed.
  routed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at   TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  accepted_at    TIMESTAMPTZ,
  declined_at    TIMESTAMPTZ,
  first_contact_logged_at TIMESTAMPTZ,
  outcome        TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     TEXT,
  UNIQUE (lead_id, recipient_id)
);

CREATE INDEX lead_deliveries_by_recipient ON lead_deliveries (recipient_id, routed_at DESC);

-- Billing. One flat charge per delivered qualified lead.
CREATE TABLE lead_charges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  delivery_id     UUID NOT NULL REFERENCES lead_deliveries(id) ON DELETE RESTRICT,
  recipient_id    UUID NOT NULL REFERENCES lead_recipients(id),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  -- Resolved from fee_schedule by practice area and county. Nothing else feeds it.
  fee_schedule_id UUID NOT NULL REFERENCES fee_schedule(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  stripe_invoice_item_id TEXT UNIQUE,
  status          payment_status NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at     TIMESTAMPTZ,
  -- One charge per lead. A re-delivery does not re-bill.
  UNIQUE (lead_id)
);

CREATE TABLE lead_disputes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  charge_id    UUID REFERENCES lead_charges(id),
  recipient_id UUID NOT NULL REFERENCES lead_recipients(id),
  reason       TEXT NOT NULL,
  detail       TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'rejected')),
  raised_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  UUID REFERENCES users(id),
  resolution_note TEXT,
  CONSTRAINT resolved_disputes_record_who
    CHECK (status = 'open' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);

CREATE INDEX lead_disputes_open ON lead_disputes (raised_at DESC) WHERE status = 'open';

/*
 * Guard against a contingent fee being introduced later by accident.
 *
 * Non-negotiable #2 is the kind of rule that erodes: someone adds "and scale it a bit for
 * bigger matters" and nobody notices it crossed a line. The fee on a lead charge must
 * equal the published flat fee for its practice area and county, full stop.
 */
CREATE OR REPLACE FUNCTION lead_charges_are_flat()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  published INTEGER;
BEGIN
  SELECT amount_cents INTO published FROM fee_schedule WHERE id = NEW.fee_schedule_id;
  IF published IS NULL THEN
    RAISE EXCEPTION 'Lead charge references a fee schedule row that does not exist.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amount_cents IS DISTINCT FROM published THEN
    RAISE EXCEPTION
      'Lead charge (% cents) does not equal the published flat fee (% cents). Referral fees are flat and never vary by case.',
      NEW.amount_cents, published
      USING ERRCODE = 'restrict_violation',
            HINT = 'v2 non-negotiable #2: never contingent on case value, retention, or attorney fees.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lead_charges_enforce_flat_fee
  BEFORE INSERT OR UPDATE ON lead_charges
  FOR EACH ROW EXECUTE FUNCTION lead_charges_are_flat();

/*
 * Non-negotiable #3, enforced at the moment it matters: billing.
 */
CREATE OR REPLACE FUNCTION lead_charges_require_representation_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  checked BOOLEAN;
BEGIN
  SELECT not_already_represented INTO checked FROM leads WHERE id = NEW.lead_id;
  IF checked IS NOT TRUE THEN
    RAISE EXCEPTION
      'Cannot bill a lead without a completed not-already-represented check.'
      USING ERRCODE = 'restrict_violation',
            HINT = 'v2 non-negotiable #3.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lead_charges_enforce_representation_check
  BEFORE INSERT ON lead_charges
  FOR EACH ROW EXECUTE FUNCTION lead_charges_require_representation_check();

COMMIT;
