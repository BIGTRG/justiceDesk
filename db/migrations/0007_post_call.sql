-- 0007_post_call.sql — the post-call landing, payment links and one-shot documents.
--
-- v2 §4: "Post-call landing (SMS link target): shows THEIR call summary, their document
-- or case already started, one-tap pay/continue."
--
-- The link is texted to a phone. Anyone who picks up that phone, or is forwarded the
-- message, holds it. So the token is treated as a capability, not an identifier:
--
--   * stored as a SHA-256 hash, never in plaintext — a database leak does not hand
--     someone a working link to a stranger's legal matter;
--   * expires;
--   * revocable;
--   * every use is audited.
--
-- What the landing page may show is deliberately narrow. It is NOT the case portal:
-- reaching the actual case requires phone-OTP sign-in (v2 §4, "lightweight account").

BEGIN;

CREATE TABLE call_landing_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id      UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  -- SHA-256 of the token. The plaintext exists only in the SMS.
  token_hash   TEXT NOT NULL UNIQUE,
  -- Short by intent. Long enough for the rung-6 drip re-hook to still work, short
  -- enough that a forwarded text stops being a live capability.
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  use_count    INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0)
);

CREATE INDEX call_landing_tokens_by_call ON call_landing_tokens (call_id);
CREATE INDEX call_landing_tokens_live ON call_landing_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- The guardrailed summary shown on the landing page.
--
-- Separate from `calls` because it is model output and therefore passes through the UPL
-- pipeline before it is stored. A summary that the guardrails blocked has no row here,
-- and the landing page shows a neutral fallback rather than nothing at all.
CREATE TABLE call_summaries (
  call_id            UUID PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  -- Plain-language recap of what the caller said. Never a legal conclusion.
  summary_text       TEXT NOT NULL,
  -- What the platform can prepare next, as template keys. Offers, not advice.
  suggested_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  detected_case_type TEXT,
  -- Outcome of the guardrail pipeline that produced this text.
  guardrail_outcome  TEXT NOT NULL CHECK (guardrail_outcome IN ('passed', 'repaired', 'blocked')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rung 3: a caller pays once, gets a real document, and an account exists afterwards.
--
-- Deliberately NOT a `cases` row at purchase time. A one-shot buyer has not opened a
-- case and should not be shown a case portal they did not buy; the case is created only
-- if they convert to a subscription (rung 4).
CREATE TABLE one_shot_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id           UUID REFERENCES calls(id) ON DELETE SET NULL,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  user_id           UUID REFERENCES users(id),
  template_id       UUID NOT NULL REFERENCES document_templates(id),
  fee_schedule_id   UUID NOT NULL REFERENCES fee_schedule(id),
  -- Answers lifted from the call transcript, so the caller re-enters nothing (#7).
  answers           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Set once svc-jobs has rendered it.
  document_id       UUID REFERENCES documents(id),
  status            TEXT NOT NULL DEFAULT 'awaiting_payment'
                    CHECK (status IN ('awaiting_payment', 'paid', 'rendering', 'ready', 'failed', 'refunded')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,

  -- Nothing is rendered before it is paid for. Enforced rather than assumed, because
  -- the render worker is triggered by a webhook and webhooks can be replayed.
  CONSTRAINT rendered_only_after_payment
    CHECK (status IN ('awaiting_payment', 'refunded') OR paid_at IS NOT NULL)
);

CREATE INDEX one_shot_documents_by_call ON one_shot_documents (call_id);
CREATE INDEX one_shot_documents_by_user ON one_shot_documents (user_id, created_at DESC);

-- Link a call to the case it seeded, so a subscribing caller never re-enters anything
-- (v2 non-negotiable #7). Nullable on `calls` already; this records the direction and
-- the fact that prefill happened, for the lossless-intake audit.
CREATE TABLE call_case_prefills (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id     UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  -- Which fields came across, so a gap is visible rather than silent.
  fields      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_id, case_id)
);

COMMIT;
