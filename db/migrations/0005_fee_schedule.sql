-- 0005_fee_schedule.sql — every price becomes an owner-adjustable line item.
--
-- v2 §3: "No fee is hardcoded anywhere. Owner makes all fee decisions in the admin
-- panel, not in code."
--
-- Phase 1 already kept prices in the database rather than in code, so this is a reshape,
-- not a rescue: `plans` becomes `fee_schedule` with the wider shape v2 needs (key,
-- category, unit, jurisdiction scope, version, effective_at).
--
-- Row IDs are preserved through the migration so existing subscriptions.plan_id and
-- payments.plan_id values stay valid and are simply repointed.

BEGIN;

CREATE TYPE fee_category AS ENUM (
  'subscription',       -- monthly case plans
  'one_shot_document',  -- single prepared document
  'call_per_minute',    -- metered voice (v2 rung 2)
  'call_session',       -- flat "Full Answer Session"
  'call_credit_pack',   -- prepaid packs
  'chat_session',
  'responsive_document', -- incoming document center
  'discovery_pack',
  'motion_pack',
  'referral_lead',      -- flat per-qualified-lead advertising fee (v2 rung 5)
  'gsign_event',
  'sealproof_seal',
  'efile',
  'standby',
  'other'
);

CREATE TYPE fee_unit AS ENUM ('month', 'document', 'minute', 'session', 'pack', 'lead', 'event', 'each');

CREATE TABLE fee_schedule (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  -- Stable machine key, e.g. 'debt_defense.monthly' or 'referral.family.wake'.
  -- Code refers to fees by key; the amount behind it is the owner's to change.
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        fee_category NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  unit            fee_unit NOT NULL,
  case_type_id    UUID REFERENCES case_types(id),
  jurisdiction_id UUID REFERENCES jurisdictions(id),
  status          plan_status NOT NULL DEFAULT 'draft',
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  effective_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  stripe_price_id TEXT UNIQUE,
  superseded_by   UUID REFERENCES fee_schedule(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id),
  -- Every amount ships as an owner-adjustable placeholder until the owner sets it.
  -- Surfaced in the admin board so nobody mistakes a seeded number for a decision.
  is_placeholder  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, key, version)
);

-- One live version per fee key per tenant. Publishing a new version retires the old one.
CREATE UNIQUE INDEX one_live_fee_per_tenant_and_key
  ON fee_schedule (tenant_id, key)
  WHERE status = 'live';

CREATE INDEX fee_schedule_by_category ON fee_schedule (tenant_id, category, status);

-- ---------------------------------------------------------------- migrate plans in
--
-- IDs are preserved, so every subscriptions.plan_id / payments.plan_id keeps resolving.

INSERT INTO fee_schedule
  (id, tenant_id, key, name, category, amount_cents, unit, case_type_id, status,
   stripe_price_id, superseded_by, created_at, is_placeholder)
SELECT
  p.id,
  p.tenant_id,
  ct.key || '.' || p.kind::text,
  p.name,
  (CASE WHEN p.kind = 'monthly' THEN 'subscription' ELSE 'one_shot_document' END)::fee_category,
  p.price_cents,
  (CASE WHEN p.kind = 'monthly' THEN 'month' ELSE 'document' END)::fee_unit,
  p.case_type_id,
  p.status,
  p.stripe_price_id,
  p.superseded_by,
  p.created_at,
  TRUE
FROM plans p
JOIN case_types ct ON ct.id = p.case_type_id;

-- ---------------------------------------------------------------- repoint references

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_plan_id_fkey;
ALTER TABLE subscriptions RENAME COLUMN plan_id TO fee_schedule_id;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_fee_schedule_id_fkey
  FOREIGN KEY (fee_schedule_id) REFERENCES fee_schedule(id);

ALTER TABLE payments DROP CONSTRAINT payments_plan_id_fkey;
ALTER TABLE payments RENAME COLUMN plan_id TO fee_schedule_id;
ALTER TABLE payments
  ADD CONSTRAINT payments_fee_schedule_id_fkey
  FOREIGN KEY (fee_schedule_id) REFERENCES fee_schedule(id);

-- ---------------------------------------------------------------- carry the Phase 1 invariants
--
-- Non-negotiable #4 (price changes affect new signups only) transfers wholesale. The
-- old triggers referenced `plans`, so they are recreated against fee_schedule before
-- the table is dropped.

DROP TRIGGER plans_freeze_live_pricing ON plans;
DROP TRIGGER subscriptions_freeze_plan ON subscriptions;

CREATE OR REPLACE FUNCTION fee_schedule_live_rows_are_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'live' THEN
    IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents THEN
      RAISE EXCEPTION
        'Cannot change the amount of a live fee item "%" (% -> % cents). Publish a new version instead.',
        OLD.key, OLD.amount_cents, NEW.amount_cents
        USING ERRCODE = 'restrict_violation',
              HINT = 'Fee changes apply to new purchases only.';
    END IF;
    IF NEW.key IS DISTINCT FROM OLD.key
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.unit IS DISTINCT FROM OLD.unit
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'Cannot repoint a live fee item to a different key, category, unit or tenant.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fee_schedule_freeze_live
  BEFORE UPDATE ON fee_schedule
  FOR EACH ROW EXECUTE FUNCTION fee_schedule_live_rows_are_frozen();

CREATE OR REPLACE FUNCTION subscriptions_fee_is_pinned()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.fee_schedule_id IS DISTINCT FROM OLD.fee_schedule_id THEN
    RAISE EXCEPTION
      'A subscription is pinned to the fee item it signed up on and cannot be moved.'
      USING ERRCODE = 'restrict_violation',
            HINT = 'Cancel this subscription and create a new one on the new fee item.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscriptions_freeze_fee
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_fee_is_pinned();

DROP FUNCTION plans_live_rows_are_frozen();
DROP FUNCTION subscriptions_plan_is_pinned();
DROP TABLE plans;

-- ---------------------------------------------------------------- v2 fee lines
--
-- Seeded as DRAFT placeholders with the amounts named in the v2 spec. Draft means not
-- purchasable: the owner sets the real number and publishes from the admin board.
-- `referral_lead` amounts are deliberately NOT seeded — see HUMAN_REVIEW.md; the fee
-- structure is a compliance question before it is a pricing one.

INSERT INTO fee_schedule (tenant_id, key, name, category, amount_cents, unit, status, is_placeholder)
SELECT t.id, v.key, v.name, v.category::fee_category, v.amount_cents, v.unit::fee_unit, 'draft', TRUE
FROM tenants t,
  (VALUES
    ('call.per_minute',        'Metered call, per minute',      'call_per_minute',    199,  'minute'),
    ('call.flat_session',      'Full Answer Session',           'call_session',       900,  'session'),
    ('call.credit_pack_20',    'Call credit pack — $20',        'call_credit_pack',  2000,  'pack'),
    ('call.credit_pack_50',    'Call credit pack — $50',        'call_credit_pack',  5000,  'pack'),
    ('chat.flat_session',      'Chat session',                  'chat_session',       900,  'session'),
    ('document.one_shot',      'One-shot prepared document',    'one_shot_document', 3900,  'document'),
    ('document.responsive',    'Responsive document',           'responsive_document', 0,   'document'),
    ('pack.discovery',         'Discovery Response Pack',       'discovery_pack',       0,  'each'),
    ('pack.motion',            'Motion Pack',                   'motion_pack',          0,  'each')
  ) AS v(key, name, category, amount_cents, unit)
WHERE t.key = 'justice_desk';

COMMIT;
