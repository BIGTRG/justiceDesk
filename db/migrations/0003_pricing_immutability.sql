-- 0003_pricing_immutability.sql — non-negotiable #4: price changes affect new signups only.
--
-- The admin pricing board can edit prices freely while a plan is a draft. Once a plan is
-- live it is frozen: changing its price would silently reprice every subscriber pinned to
-- that row, which is both a billing defect and a consumer-protection problem for a product
-- serving people who are already being sued over money.
--
-- Raising a price therefore means publishing a NEW plan row and superseding the old one.
-- Existing subscriptions keep pointing at the old row and keep the old price.

BEGIN;

CREATE OR REPLACE FUNCTION plans_live_rows_are_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'live' THEN
    IF NEW.price_cents IS DISTINCT FROM OLD.price_cents THEN
      RAISE EXCEPTION
        'Cannot change the price of a live plan (% -> % cents). Publish a new plan and supersede this one.',
        OLD.price_cents, NEW.price_cents
        USING ERRCODE = 'restrict_violation',
              HINT = 'Price changes apply to new signups only.';
    END IF;

    IF NEW.case_type_id IS DISTINCT FROM OLD.case_type_id
       OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'Cannot repoint a live plan to a different case type or billing kind.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Retiring a plan is allowed: live -> draft removes it from sale without touching
    -- anyone already subscribed to it.
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER plans_freeze_live_pricing
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION plans_live_rows_are_frozen();

-- A subscription may never be repointed to a different plan row, for the same reason.
CREATE OR REPLACE FUNCTION subscriptions_plan_is_pinned()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    RAISE EXCEPTION
      'A subscription is pinned to the plan it signed up on and cannot be moved.'
      USING ERRCODE = 'restrict_violation',
            HINT = 'Cancel this subscription and create a new one on the new plan.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscriptions_freeze_plan
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_plan_is_pinned();

-- Likewise, a case may never be moved onto a different workflow definition version
-- (non-negotiable #3). A case rides the version it opened on to close.
CREATE OR REPLACE FUNCTION cases_workflow_version_is_pinned()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workflow_definition_id IS DISTINCT FROM OLD.workflow_definition_id THEN
    RAISE EXCEPTION
      'A case is pinned to the workflow version it opened on and cannot be migrated.'
      USING ERRCODE = 'restrict_violation',
            HINT = 'Publishing a new workflow version affects new cases only.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_freeze_workflow_version
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_workflow_version_is_pinned();

-- Published workflow definitions are immutable. Editing one would move the goal posts
-- under every case pinned to it.
CREATE OR REPLACE FUNCTION workflow_definitions_live_rows_are_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'live' AND NEW.definition IS DISTINCT FROM OLD.definition THEN
    RAISE EXCEPTION
      'Cannot edit a published workflow definition. Publish a new version instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_definitions_freeze_live
  BEFORE UPDATE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION workflow_definitions_live_rows_are_frozen();

COMMIT;
