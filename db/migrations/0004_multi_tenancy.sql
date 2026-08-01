-- 0004_multi_tenancy.sql — retrofit tenancy onto the Phase 1 schema.
--
-- v2 §5C: a sister company must be a config change, not a rebuild. That only holds if
-- tenancy is on the data from the start, so this runs before any v2 feature work.
--
-- The subtle part is NOT adding the column. It is the unique indexes: Phase 1 has two
-- partial unique indexes that are globally scoped. Left alone, tenant B publishing a
-- plan would collide with tenant A's, or worse, silently retire it. Both are rebuilt
-- tenant-scoped below.
--
-- Everything defaults to the `justice_desk` tenant, so existing rows keep working.

BEGIN;

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  -- Quietly-owned vertical brands (v2 §5C) are tenants, not separate deployments.
  kind        TEXT NOT NULL DEFAULT 'platform' CHECK (kind IN ('platform', 'vertical_brand', 'sister_company')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenants (key, name, kind) VALUES ('justice_desk', 'Justice Desk', 'platform');

-- Branding config per tenant (v2 §5C). Kept as its own table rather than columns on
-- tenants because vertical brands carry a lot of presentation state and it changes far
-- more often than the tenant record itself.
CREATE TABLE tenant_branding (
  tenant_id        UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL,
  domain           TEXT UNIQUE,
  logo_minio_key   TEXT,
  palette          JSONB NOT NULL DEFAULT '{}'::jsonb,
  support_email    TEXT,
  -- Disclosure copy is per-tenant because a vertical brand's name appears inside it.
  -- Still gated: see COMPLIANCE.md §2, all copy is draft pending counsel.
  disclosure_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenant_branding (tenant_id, display_name, domain, support_email)
SELECT id, 'Justice Desk', 'justicedesk.law', NULL FROM tenants WHERE key = 'justice_desk';

-- Inbound numbers route a call to a tenant (v2 §3 svc-voice, §5C vertical brands).
CREATE TABLE tenant_phone_numbers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  e164          TEXT NOT NULL UNIQUE,
  label         TEXT,
  language      TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tenant_phone_numbers_by_tenant ON tenant_phone_numbers (tenant_id, status);

-- ---------------------------------------------------------------- add tenant_id

DO $$
DECLARE
  default_tenant UUID;
  t TEXT;
BEGIN
  SELECT id INTO default_tenant FROM tenants WHERE key = 'justice_desk';

  FOREACH t IN ARRAY ARRAY[
    'users', 'cases', 'plans', 'documents', 'document_templates',
    'workflow_definitions', 'subscriptions', 'payments', 'ai_conversations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id UUID REFERENCES tenants(id)', t);
    EXECUTE format('UPDATE %I SET tenant_id = $1', t) USING default_tenant;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    -- The default keeps single-tenant inserts working while v2 lands. It is a
    -- migration aid, not a licence to omit tenant_id in new code.
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT %L::uuid', t, default_tenant
    );
    EXECUTE format('CREATE INDEX %I ON %I (tenant_id)', t || '_by_tenant', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------- tenant-scope the unique indexes
--
-- These two are the actual hazard. Both were global; both must be per-tenant or one
-- tenant's publish silently retires another's.

DROP INDEX one_live_plan_per_case_type_and_kind;
CREATE UNIQUE INDEX one_live_plan_per_tenant_case_type_and_kind
  ON plans (tenant_id, case_type_id, kind)
  WHERE status = 'live';

DROP INDEX one_live_definition_per_case_type_and_jurisdiction;
CREATE UNIQUE INDEX one_live_definition_per_tenant_case_type_and_jurisdiction
  ON workflow_definitions (tenant_id, case_type_id, jurisdiction_id)
  WHERE status = 'live';

-- Workflow versions are per tenant too: tenant B's v1 is not tenant A's v1.
ALTER TABLE workflow_definitions
  DROP CONSTRAINT workflow_definitions_case_type_id_jurisdiction_id_version_key;
ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_tenant_case_type_jurisdiction_version_key
  UNIQUE (tenant_id, case_type_id, jurisdiction_id, version);

-- Template keys are per tenant — a vertical brand may carry its own variant.
ALTER TABLE document_templates
  DROP CONSTRAINT document_templates_case_type_id_jurisdiction_id_key_key;
ALTER TABLE document_templates
  ADD CONSTRAINT document_templates_tenant_case_type_jurisdiction_key_key
  UNIQUE (tenant_id, case_type_id, jurisdiction_id, key);

-- ---------------------------------------------------------------- identity uniqueness
--
-- Phone and email were globally unique. Under multi-tenancy the same person can hold an
-- account with two vertical brands, and forcing one row would let brand B see brand A's
-- cases — the exact cross-tenant leak §5C's "never cross-steer" rule exists to prevent.

ALTER TABLE users DROP CONSTRAINT users_phone_key;
ALTER TABLE users DROP CONSTRAINT users_email_key;
ALTER TABLE users DROP CONSTRAINT users_clerk_user_id_key;

CREATE UNIQUE INDEX users_phone_per_tenant ON users (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX users_email_per_tenant ON users (tenant_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_clerk_id_per_tenant
  ON users (tenant_id, clerk_user_id) WHERE clerk_user_id IS NOT NULL;

-- ---------------------------------------------------------------- audit
--
-- Nullable on purpose: an audit row may describe a pre-tenant or cross-tenant admin
-- action, and refusing to record it because tenancy is unclear would defeat the log.
ALTER TABLE audit_log ADD COLUMN tenant_id UUID REFERENCES tenants(id);
UPDATE audit_log SET tenant_id = (SELECT id FROM tenants WHERE key = 'justice_desk');
CREATE INDEX audit_log_by_tenant ON audit_log (tenant_id, ts DESC);

-- ---------------------------------------------------------------- cross-tenant guard
--
-- A case must not point at another tenant's workflow definition. A FK cannot express
-- this, so it is a trigger. Without it, a mis-scoped query could pin tenant A's case to
-- tenant B's procedural content and neither side would notice until a litigant saw the
-- wrong deadline.
CREATE OR REPLACE FUNCTION cases_tenant_matches_workflow()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  wf_tenant UUID;
BEGIN
  SELECT tenant_id INTO wf_tenant FROM workflow_definitions WHERE id = NEW.workflow_definition_id;
  IF wf_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION
      'Case tenant (%) does not match its workflow definition tenant (%).', NEW.tenant_id, wf_tenant
      USING ERRCODE = 'restrict_violation',
            HINT = 'A case may only be pinned to a workflow definition owned by its own tenant.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_enforce_tenant_match
  BEFORE INSERT OR UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_tenant_matches_workflow();

COMMIT;
