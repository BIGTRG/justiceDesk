-- 0001_init.sql — core schema.
--
-- Conventions:
--   * UUID primary keys via gen_random_uuid() (pgcrypto, built in since PG13).
--   * Money is always integer cents. Never float.
--   * Calendar dates that are legal deadlines are DATE, not TIMESTAMPTZ — a filing due
--     October 3 is due October 3 in the courthouse's county, and storing an instant
--     invites a timezone off-by-one that defaults a case.
--   * Event/record times are TIMESTAMPTZ.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- enums

CREATE TYPE user_role          AS ENUM ('litigant', 'attorney', 'admin');
CREATE TYPE party_role         AS ENUM ('plaintiff', 'defendant');
CREATE TYPE case_status        AS ENUM ('draft', 'active', 'closed');
CREATE TYPE court_level        AS ENUM ('magistrate', 'district', 'superior', 'federal');
CREATE TYPE workflow_status    AS ENUM ('draft', 'live');
CREATE TYPE stage_event_status AS ENUM ('pending', 'current', 'complete');
CREATE TYPE deadline_status    AS ENUM ('pending', 'met', 'missed', 'waived');
CREATE TYPE document_kind      AS ENUM ('generated', 'uploaded', 'filed');
CREATE TYPE document_status    AS ENUM ('draft', 'final', 'filed');
CREATE TYPE template_source    AS ENUM ('aoc_form', 'ai_freeform');
CREATE TYPE interview_status   AS ENUM ('in_progress', 'complete', 'abandoned');
CREATE TYPE plan_kind          AS ENUM ('monthly', 'one_shot');
CREATE TYPE plan_status        AS ENUM ('live', 'draft');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'canceled', 'incomplete', 'trialing');
CREATE TYPE payment_status     AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
CREATE TYPE payment_kind       AS ENUM ('subscription', 'one_shot', 'attorney_review');

-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Clerk is the identity provider; this is the mapping to our own user row.
  clerk_user_id TEXT UNIQUE,
  phone       TEXT UNIQUE,
  email       TEXT UNIQUE,
  name        TEXT,
  role        user_role NOT NULL DEFAULT 'litigant',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_have_a_contact_method CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

-- ---------------------------------------------------------------- reference data

CREATE TABLE jurisdictions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key               TEXT NOT NULL UNIQUE,
  state             CHAR(2) NOT NULL,
  county            TEXT NOT NULL,
  court_level       court_level NOT NULL,
  efile_supported   BOOLEAN NOT NULL DEFAULT FALSE,
  filing_addresses  JSONB NOT NULL DEFAULT '{}'::jsonb,
  time_zone         TEXT NOT NULL DEFAULT 'America/New_York',
  UNIQUE (state, county, court_level)
);

CREATE TABLE case_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------------- workflow definitions

CREATE TABLE workflow_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type_id    UUID NOT NULL REFERENCES case_types(id),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  version         INTEGER NOT NULL CHECK (version >= 1),
  status          workflow_status NOT NULL DEFAULT 'draft',
  -- Ordered stages: {key, title, plainLanguageExplainer, deadlineRule,
  --                  requiredDocuments[], courtFeeCents, next[]}
  definition      JSONB NOT NULL,
  -- {status: 'unverified'|'attorney_verified', verifiedBy, verifiedAt, openQuestions[]}
  -- Nothing with status 'unverified' may be presented to a litigant as authoritative.
  verification    JSONB NOT NULL DEFAULT '{"status": "unverified"}'::jsonb,
  published_at    TIMESTAMPTZ,
  published_by    UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_type_id, jurisdiction_id, version),
  CONSTRAINT published_definitions_record_who_and_when
    CHECK (status <> 'live' OR (published_at IS NOT NULL AND published_by IS NOT NULL))
);

-- Only one live version per (case type, jurisdiction). New versions supersede.
CREATE UNIQUE INDEX one_live_definition_per_case_type_and_jurisdiction
  ON workflow_definitions (case_type_id, jurisdiction_id)
  WHERE status = 'live';

-- ---------------------------------------------------------------- cases

CREATE TABLE cases (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  case_type_id           UUID NOT NULL REFERENCES case_types(id),
  jurisdiction_id        UUID NOT NULL REFERENCES jurisdictions(id),
  -- Non-negotiable #3: a case pins the workflow version it started on and never moves.
  workflow_definition_id UUID NOT NULL REFERENCES workflow_definitions(id),
  court_case_number      TEXT,
  role                   party_role NOT NULL,
  status                 case_status NOT NULL DEFAULT 'draft',
  current_stage_key      TEXT NOT NULL,
  opened_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at              TIMESTAMPTZ,
  outcome                TEXT,
  -- Case facts: deadline anchors, service method, opposing party, amounts.
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT closed_cases_record_when CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);

CREATE INDEX cases_by_user ON cases (user_id, status);
CREATE INDEX cases_open ON cases (status) WHERE status = 'active';

CREATE TABLE case_stage_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  stage_key    TEXT NOT NULL,
  status       stage_event_status NOT NULL DEFAULT 'pending',
  due_date     DATE,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX case_stage_events_by_case ON case_stage_events (case_id, created_at);

CREATE TABLE deadlines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  stage_key         TEXT,
  rule_key          TEXT,
  title             TEXT NOT NULL,
  due_date          DATE NOT NULL,
  -- The statute or rule this date came from. Never null: a date we cannot source is a
  -- date we must not show.
  rule_source       TEXT NOT NULL,
  -- {offsetsDays: number[], sentOffsets: number[]}
  reminder_schedule JSONB NOT NULL DEFAULT '{"offsetsDays": [14, 7, 2, 1], "sentOffsets": []}'::jsonb,
  status            deadline_status NOT NULL DEFAULT 'pending',
  -- Mirrors the calculator's warnings so the UI can caveat an unverified date.
  warnings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  jurisdictional    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, rule_key)
);

CREATE INDEX deadlines_pending_by_date ON deadlines (due_date) WHERE status = 'pending';

-- ---------------------------------------------------------------- documents

CREATE TABLE document_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type_id       UUID NOT NULL REFERENCES case_types(id),
  jurisdiction_id    UUID NOT NULL REFERENCES jurisdictions(id),
  key                TEXT NOT NULL,
  name               TEXT NOT NULL,
  source             template_source NOT NULL,
  -- Set for aoc_form templates: the blank official PDF in MinIO.
  form_pdf_minio_key TEXT,
  -- Maps interview answer keys to AcroForm field names.
  field_map          JSONB NOT NULL DEFAULT '{}'::jsonb,
  interview_schema   JSONB NOT NULL DEFAULT '{"version": 1, "questions": []}'::jsonb,
  disclosure_text    TEXT NOT NULL,
  -- Same shape as workflow_definitions.verification. Form numbers, titles and field maps
  -- are transcribed content and must be checked against the official AOC form.
  verification       JSONB NOT NULL DEFAULT '{"status": "unverified"}'::jsonb,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_type_id, jurisdiction_id, key),
  CONSTRAINT aoc_forms_need_a_pdf
    CHECK (source <> 'aoc_form' OR form_pdf_minio_key IS NOT NULL)
);

CREATE TABLE documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind        document_kind NOT NULL,
  template_id UUID REFERENCES document_templates(id),
  title       TEXT NOT NULL,
  -- Documents live only in MinIO. Nothing is served except through an authenticated,
  -- short-lived signed URL, and every issue is written to audit_log.
  minio_key   TEXT NOT NULL UNIQUE,
  version     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  status      document_status NOT NULL DEFAULT 'draft',
  watermark   BOOLEAN NOT NULL DEFAULT TRUE,
  byte_size   BIGINT,
  sha256      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX documents_by_case ON documents (case_id, created_at DESC);

CREATE TABLE interviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  template_id  UUID NOT NULL REFERENCES document_templates(id),
  answers      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       interview_status NOT NULL DEFAULT 'in_progress',
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX interviews_by_case ON interviews (case_id);

-- ---------------------------------------------------------------- billing

CREATE TABLE plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type_id    UUID NOT NULL REFERENCES case_types(id),
  kind            plan_kind NOT NULL,
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  name            TEXT NOT NULL,
  stripe_price_id TEXT UNIQUE,
  status          plan_status NOT NULL DEFAULT 'draft',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by   UUID REFERENCES plans(id)
);

-- Only one live plan per (case type, kind) at a time. A price change publishes a new row
-- and supersedes the old one — see 0003_pricing_immutability.sql.
CREATE UNIQUE INDEX one_live_plan_per_case_type_and_kind
  ON plans (case_type_id, kind)
  WHERE status = 'live';

CREATE TABLE subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id),
  case_id                UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  -- Non-negotiable #4: the subscription pins the plan row it signed up on, so a later
  -- price change cannot reach an existing subscriber.
  plan_id                UUID NOT NULL REFERENCES plans(id),
  stripe_subscription_id TEXT UNIQUE,
  status                 subscription_status NOT NULL DEFAULT 'incomplete',
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at            TIMESTAMPTZ
);

CREATE INDEX subscriptions_by_case ON subscriptions (case_id, status);

CREATE TABLE payments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id),
  case_id                  UUID REFERENCES cases(id) ON DELETE SET NULL,
  plan_id                  UUID REFERENCES plans(id),
  stripe_payment_intent_id TEXT UNIQUE,
  amount_cents             INTEGER NOT NULL CHECK (amount_cents >= 0),
  kind                     payment_kind NOT NULL,
  status                   payment_status NOT NULL DEFAULT 'pending',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- AI + UPL

CREATE TABLE ai_conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    UUID REFERENCES cases(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  -- [{role, content, at, model, groundingRefs[]}]
  messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Rollup of guardrail outcomes for this conversation.
  flags      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_conversations_by_case ON ai_conversations (case_id, updated_at DESC);

CREATE TABLE upl_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  message_index   INTEGER NOT NULL CHECK (message_index >= 0),
  -- Guardrail code, e.g. upl.directive_you_should, or 'classifier' for the model layer.
  code            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('block', 'review', 'note')),
  reason          TEXT NOT NULL,
  excerpt         TEXT,
  -- Whether the response was withheld from the litigant.
  blocked         BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed        BOOLEAN NOT NULL DEFAULT FALSE,
  reviewer_id     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reviewed_flags_record_reviewer
    CHECK (reviewed = FALSE OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE INDEX upl_flags_review_queue ON upl_flags (created_at DESC) WHERE reviewed = FALSE;

-- ---------------------------------------------------------------- audit (WORM)

-- Append-only. Enforcement lives in 0002_audit_worm.sql.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   UUID REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  ip         INET,
  user_agent TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_by_entity ON audit_log (entity, entity_id, ts DESC);
CREATE INDEX audit_log_by_actor ON audit_log (actor_id, ts DESC);
CREATE INDEX audit_log_by_action ON audit_log (action, ts DESC);

COMMIT;
