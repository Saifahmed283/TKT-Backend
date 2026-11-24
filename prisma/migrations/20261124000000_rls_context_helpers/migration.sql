-- Transaction-local RLS context helpers.
-- Migration sessions are internal so schema changes can proceed under FORCE RLS.
SELECT set_config('app.is_internal', 'true', false);

CREATE OR REPLACE FUNCTION app_setting(p_name text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting(p_name, true), '')
$$;

CREATE OR REPLACE FUNCTION app_is_internal()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(app_setting('app.is_internal'), 'false') = 'true'
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(app_setting('app.is_super_admin'), 'false') = 'true'
$$;

CREATE OR REPLACE FUNCTION app_is_auth()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(app_setting('app.is_auth'), 'false') = 'true'
$$;

CREATE OR REPLACE FUNCTION app_is_public()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(app_setting('app.is_public'), 'false') = 'true'
$$;

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT app_setting('app.user_id')
$$;

CREATE OR REPLACE FUNCTION app_current_org_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT app_setting('app.org_id')
$$;

CREATE OR REPLACE FUNCTION app_public_event_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT app_setting('app.public_event_id')
$$;

CREATE OR REPLACE FUNCTION app_allowed_event_ids()
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN app_setting('app.event_ids') IS NOT NULL
      THEN array_remove(string_to_array(app_setting('app.event_ids'), ','), '')
    WHEN app_setting('app.event_id') IS NOT NULL
      THEN ARRAY[app_setting('app.event_id')]
    ELSE ARRAY[]::text[]
  END
$$;

-- Context-only checks. These deliberately do not query application tables, so
-- they are safe to call from policies on those same tables.
CREATE OR REPLACE FUNCTION app_can_access_org(p_org_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_is_internal()
    OR app_is_super_admin()
    OR (p_org_id IS NOT NULL AND p_org_id = app_current_org_id())
$$;

CREATE OR REPLACE FUNCTION app_can_access_event(p_event_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_is_internal()
    OR app_is_super_admin()
    OR (p_event_id IS NOT NULL AND p_event_id = ANY(app_allowed_event_ids()))
$$;

-- Public writes are limited to the event named in /public/events/:eventId.
CREATE OR REPLACE FUNCTION app_can_write_public_event(p_event_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_is_public()
    AND p_event_id IS NOT NULL
    AND p_event_id = app_public_event_id()
$$;

-- Public reads also include published/completed events for listings and stats.
CREATE OR REPLACE FUNCTION app_can_view_public_event(p_event_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_can_write_public_event(p_event_id)
    OR (
      app_is_public()
      AND p_event_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "Event" e
        WHERE e."id" = p_event_id
          AND e."status" IN ('PUBLISHED', 'LIVE', 'COMPLETED', 'ARCHIVED')
      )
    )
$$;

-- Membership checks are SECURITY DEFINER so they can be called from policies
-- on the same tables without recursive RLS evaluation. The migration role has
-- BYPASSRLS; keep the pinned search_path. Only ACTIVE memberships count.
CREATE OR REPLACE FUNCTION app_user_can_see_org(p_org_id text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_org_id IS NOT NULL
    AND app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "OrganizationMember" om
      WHERE om."orgId" = p_org_id
        AND om."userId" = app_current_user_id()
        AND om."status" = 'ACTIVE'
    )
$$;

CREATE OR REPLACE FUNCTION app_user_admin_org(p_org_id text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_org_id IS NOT NULL
    AND app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "OrganizationMember" om
      WHERE om."orgId" = p_org_id
        AND om."userId" = app_current_user_id()
        AND om."status" = 'ACTIVE'
        AND om."role" IN ('OWNER', 'ADMIN')
    )
$$;

-- Direct event membership, independent of organization membership.
CREATE OR REPLACE FUNCTION app_user_is_event_member(p_event_id text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_event_id IS NOT NULL
    AND app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "EventMember" em
      WHERE em."eventId" = p_event_id
        AND em."userId" = app_current_user_id()
        AND em."status" = 'ACTIVE'
    )
$$;

-- Full event visibility: direct event membership or ACTIVE org membership.
CREATE OR REPLACE FUNCTION app_user_can_see_event(p_event_id text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_event_id IS NOT NULL
    AND app_current_user_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM "EventMember" em
        WHERE em."eventId" = p_event_id
          AND em."userId" = app_current_user_id()
          AND em."status" = 'ACTIVE'
      )
      OR EXISTS (
        SELECT 1 FROM "Event" e
        JOIN "OrganizationMember" om ON om."orgId" = e."orgId"
        WHERE e."id" = p_event_id
          AND om."userId" = app_current_user_id()
          AND om."status" = 'ACTIVE'
      )
    )
$$;
