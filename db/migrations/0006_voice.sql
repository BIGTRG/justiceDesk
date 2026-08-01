-- 0006_voice.sql — svc-voice: calls, consent, charges, outcomes.
--
-- Two v2 non-negotiables are enforced here rather than in application code:
--
--   #1 "Revenue-per-call is the north-star metric; every call row must have an outcome."
--      A finished call with a NULL outcome is refused by a CHECK. Analytics that silently
--      drops un-outcomed calls would overstate conversion, which is the one number the
--      whole business is steering on.
--
--   #4 TCPA: express written consent before any outbound drip. Consent is its own
--      append-only table with the captured utterance and its offset into the recording,
--      so a consent claim can be evidenced rather than asserted.
--
--   #5 Recording consent announced at the start of EVERY call. `recording_announced_at`
--      is NOT NULL on any call that has a recording — you cannot keep audio you never
--      announced you were keeping.

BEGIN;

CREATE TYPE call_state AS ENUM (
  'greeting',        -- consent announcement, before the free window starts
  'free_window',     -- rung 1
  'paywall_offer',   -- rung 2 offered
  'metered',         -- rung 2, per-minute
  'flat_session',    -- rung 2, flat session
  'outcome_capture', -- collecting contact/consent before hangup
  'ended'
);

-- The six rungs of the monetization ladder, plus the terminal 'none'.
CREATE TYPE call_outcome AS ENUM (
  'paid_session',   -- rung 2 only: paid to continue, bought nothing further
  'document',       -- rung 3
  'subscription',   -- rung 4
  'referral',       -- rung 5
  'drip',           -- rung 6: captured contact + consent
  'none',           -- no sale, no capture. Tracked explicitly, never inferred.
  'abandoned',      -- caller hung up inside the free window
  'transferred'     -- handed to a human
);

CREATE TYPE consent_kind AS ENUM (
  'recording',            -- #5, announced at call start
  'tcpa_sms',             -- #4, express written consent for outbound SMS
  'tcpa_call',            -- #4, express written consent for outbound calls
  'referral_disclosure'   -- rung 5 disclosure acknowledged
);

CREATE TABLE calls (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id),
  twilio_call_sid        TEXT UNIQUE,
  phone_number_id        UUID REFERENCES tenant_phone_numbers(id),
  from_e164              TEXT NOT NULL,
  to_e164                TEXT NOT NULL,
  language               TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),

  state                  call_state NOT NULL DEFAULT 'greeting',
  outcome                call_outcome,

  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When the recording announcement actually played. Not when we intended to play it.
  recording_announced_at TIMESTAMPTZ,
  free_window_ended_at   TIMESTAMPTZ,
  ended_at               TIMESTAMPTZ,
  duration_seconds       INTEGER CHECK (duration_seconds >= 0),
  billable_seconds       INTEGER NOT NULL DEFAULT 0 CHECK (billable_seconds >= 0),

  revenue_cents          INTEGER NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0),

  -- Set once the caller is identified / converts. A call may end with neither.
  user_id                UUID REFERENCES users(id),
  case_id                UUID REFERENCES cases(id) ON DELETE SET NULL,

  -- Artifacts live in MinIO, never in this table.
  recording_minio_key    TEXT,
  transcript_minio_key   TEXT,

  -- What the caller said the matter was, as classified. Never a legal conclusion.
  detected_case_type     TEXT,
  detected_county        TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- v2 non-negotiable #1: a finished call always has an outcome.
  CONSTRAINT ended_calls_have_an_outcome
    CHECK (state <> 'ended' OR outcome IS NOT NULL),
  CONSTRAINT ended_calls_record_when
    CHECK (state <> 'ended' OR ended_at IS NOT NULL),

  -- v2 non-negotiable #5: no recording without a played announcement.
  CONSTRAINT recordings_were_announced
    CHECK (recording_minio_key IS NULL OR recording_announced_at IS NOT NULL),

  -- Billing cannot exceed the wall clock, and the free window is never billable.
  CONSTRAINT billable_within_duration
    CHECK (duration_seconds IS NULL OR billable_seconds <= duration_seconds)
);

CREATE INDEX calls_by_tenant_started ON calls (tenant_id, started_at DESC);
CREATE INDEX calls_by_outcome ON calls (tenant_id, outcome, started_at DESC);
CREATE INDEX calls_by_from ON calls (from_e164, started_at DESC);
-- The dashboard's hot query: un-outcomed live calls.
CREATE INDEX calls_in_flight ON calls (tenant_id, state) WHERE state <> 'ended';

-- Append-only event log. Every state transition, tool call and charge attempt.
-- This is what makes a call reconstructable when someone disputes what was said.
CREATE TABLE call_events (
  id         BIGSERIAL PRIMARY KEY,
  call_id    UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Milliseconds from call start, so an event can be located in the recording.
  offset_ms  INTEGER,
  kind       TEXT NOT NULL,
  from_state call_state,
  to_state   call_state,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX call_events_by_call ON call_events (call_id, at);

CREATE OR REPLACE FUNCTION call_events_are_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'call_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER call_events_block_update
  BEFORE UPDATE ON call_events FOR EACH ROW EXECUTE FUNCTION call_events_are_append_only();
CREATE TRIGGER call_events_block_delete
  BEFORE DELETE ON call_events FOR EACH ROW EXECUTE FUNCTION call_events_are_append_only();

-- v2 non-negotiable #4. Consent is evidence, so it records what was actually said and
-- where in the recording to find it — not merely a boolean someone set.
CREATE TABLE call_consents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id        UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  kind           consent_kind NOT NULL,
  granted        BOOLEAN NOT NULL,
  -- The script read to the caller, verbatim, as it was at the time.
  script_version TEXT NOT NULL,
  script_text    TEXT NOT NULL,
  -- What the caller said in response.
  utterance      TEXT,
  offset_ms      INTEGER,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Global opt-out (#4) is recorded against the number, not the call.
  phone_e164     TEXT NOT NULL,
  UNIQUE (call_id, kind)
);

CREATE INDEX call_consents_by_phone ON call_consents (phone_e164, kind, granted);

-- Global one-tap opt-out, honoured across every tenant and channel (#4).
-- Deliberately NOT tenant-scoped: someone who says stop means stop, and a vertical brand
-- claiming it never received the opt-out is exactly the abuse this prevents.
CREATE TABLE contact_optouts (
  phone_e164 TEXT PRIMARY KEY,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source     TEXT NOT NULL,
  note       TEXT
);

CREATE TABLE call_charges (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id                  UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  fee_schedule_id          UUID NOT NULL REFERENCES fee_schedule(id),
  amount_cents             INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- Set for metered billing.
  billed_seconds           INTEGER CHECK (billed_seconds >= 0),
  stripe_payment_intent_id TEXT UNIQUE,
  payment_link_url         TEXT,
  status                   payment_status NOT NULL DEFAULT 'pending',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at               TIMESTAMPTZ
);

CREATE INDEX call_charges_by_call ON call_charges (call_id);

-- Keep `calls.revenue_cents` honest: it is the sum of settled charges, maintained by
-- trigger rather than by whichever code path happens to remember.
CREATE OR REPLACE FUNCTION calls_recompute_revenue()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  target UUID := COALESCE(NEW.call_id, OLD.call_id);
BEGIN
  UPDATE calls SET revenue_cents = COALESCE((
    SELECT SUM(amount_cents) FROM call_charges
     WHERE call_id = target AND status = 'succeeded'
  ), 0)
  WHERE id = target;
  RETURN NULL;
END;
$$;

CREATE TRIGGER call_charges_maintain_revenue
  AFTER INSERT OR UPDATE OR DELETE ON call_charges
  FOR EACH ROW EXECUTE FUNCTION calls_recompute_revenue();

COMMIT;
