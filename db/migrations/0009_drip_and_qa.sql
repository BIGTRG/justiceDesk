-- 0009_drip_and_qa.sql — drip automation, call economics, voice QA queue.
--
-- v2 §5D and rung 6. The drip is the part with legal teeth: it sends unsolicited SMS to
-- people who called once. TCPA turns on express written consent and on honouring an
-- opt-out, so both are enforced in the schema rather than trusted to the worker.

BEGIN;

CREATE TABLE drip_campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  case_type     TEXT,
  -- Ordered steps: [{offsetHours, templateKey, body}]
  steps         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Draft until someone deliberately publishes it, same posture as fees and workflows.
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused')),
  -- ⚠️ Copy pending counsel. See HUMAN_REVIEW.md L-2.
  copy_approved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE drip_enrollments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES drip_campaigns(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  call_id       UUID REFERENCES calls(id) ON DELETE SET NULL,
  phone_e164    TEXT NOT NULL,
  -- Denormalised proof, so a send never has to infer consent from somewhere else.
  consent_call_id UUID REFERENCES calls(id),
  consented_at  TIMESTAMPTZ NOT NULL,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_step     INTEGER NOT NULL DEFAULT 0 CHECK (next_step >= 0),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'completed', 'stopped', 'suppressed')),
  stopped_at    TIMESTAMPTZ,
  stop_reason   TEXT,
  UNIQUE (campaign_id, phone_e164)
);

CREATE INDEX drip_enrollments_due ON drip_enrollments (status, next_step) WHERE status = 'active';

CREATE TABLE drip_sends (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES drip_enrollments(id) ON DELETE CASCADE,
  step_index    INTEGER NOT NULL CHECK (step_index >= 0),
  phone_e164    TEXT NOT NULL,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_sid  TEXT,
  status        TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'suppressed')),
  -- A send that was withheld records why, so suppression is auditable.
  suppressed_reason TEXT,
  UNIQUE (enrollment_id, step_index)
);

/*
 * TCPA, enforced at the send.
 *
 * A row may not be recorded as 'sent' to a number that has opted out. The worker checks
 * too, but the worker is where a bug would live — this is the backstop, and it is the
 * difference between "we believe we honoured it" and "we could not have failed to".
 */
CREATE OR REPLACE FUNCTION drip_sends_respect_optout()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'sent' AND EXISTS (
    SELECT 1 FROM contact_optouts WHERE phone_e164 = NEW.phone_e164
  ) THEN
    RAISE EXCEPTION 'Refusing to record a send to a number that has opted out (%).', NEW.phone_e164
      USING ERRCODE = 'restrict_violation',
            HINT = 'v2 non-negotiable #4: one-tap opt-out is honoured globally.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER drip_sends_enforce_optout
  BEFORE INSERT OR UPDATE ON drip_sends
  FOR EACH ROW EXECUTE FUNCTION drip_sends_respect_optout();

/*
 * Voice QA queue (v2 §5D): sampled call transcripts flagged by the UPL classifier.
 *
 * Separate from `upl_flags`, which is per AI message. This is per call, so a reviewer can
 * judge a conversation rather than a sentence out of context.
 */
CREATE TABLE voice_qa_samples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  -- Why this call was pulled: 'flagged' by the classifier, or 'random' sampling.
  reason        TEXT NOT NULL CHECK (reason IN ('flagged', 'random', 'disputed', 'complaint')),
  flag_codes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewed      BOOLEAN NOT NULL DEFAULT FALSE,
  reviewer_id   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  verdict       TEXT CHECK (verdict IN ('ok', 'minor', 'crossed_line', 'unclear')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_id),
  CONSTRAINT reviewed_samples_record_who
    CHECK (reviewed = FALSE OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND verdict IS NOT NULL))
);

CREATE INDEX voice_qa_queue ON voice_qa_samples (created_at DESC) WHERE reviewed = FALSE;

COMMIT;
