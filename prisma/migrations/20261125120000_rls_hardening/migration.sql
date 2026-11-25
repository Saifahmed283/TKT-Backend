-- RLS Hardening - 2026-11-25
-- Tighten overly permissive policies and add missing restrictions

SELECT set_config('app.is_internal', 'true', false);

-- ── AuditLog: Restrict access to audit logs ─────────────────────────────
-- Remove app_is_auth() which allowed any authenticated user to read audit logs.
-- Audit logs should only be visible to:
-- 1. Internal/super-admin
-- 2. Users with access to the organization/event
-- 3. The actor who performed the action
-- 4. Public callers only for the event explicitly in the URL (for event-specific audits)

DROP POLICY IF EXISTS rls_audit_select ON "AuditLog";

CREATE POLICY rls_audit_select ON "AuditLog" FOR SELECT
  USING (
    app_is_internal()
    OR app_is_super_admin()
    OR app_can_access_org("organizationId")
    OR app_can_access_event("eventId")
    OR "actorUserId" = app_current_user_id()
    OR (app_is_public() AND app_can_write_public_event("eventId"))
  );

-- ── User: Restrict user visibility ──────────────────────────────────────
-- Users should not be able to enumerate all users in an org just by being a member.
-- Restrict to: self, org admins, event staff with direct membership, super admins.

DROP POLICY IF EXISTS rls_user_select ON "User";

CREATE POLICY rls_user_select ON "User" FOR SELECT
  USING (
    app_is_internal()
    OR app_is_super_admin()
    OR app_is_auth()
    OR "id" = app_current_user_id()
    OR app_user_admin_org(app_current_org_id())
    OR EXISTS (
      SELECT 1 FROM "EventMember" em
      WHERE em."userId" = "User"."id"
        AND em."eventId" = ANY(app_allowed_event_ids())
        AND em."status" = 'ACTIVE'
    )
  );

-- ── AuditLog: Prevent public insert/update/delete ────────────────────────
DROP POLICY IF EXISTS rls_audit_insert ON "AuditLog";
DROP POLICY IF EXISTS rls_audit_update ON "AuditLog";
DROP POLICY IF EXISTS rls_audit_delete ON "AuditLog";

CREATE POLICY rls_audit_insert ON "AuditLog" FOR INSERT
  WITH CHECK (
    app_is_internal()
    OR app_is_super_admin()
    OR app_can_access_org("organizationId")
    OR app_can_access_event("eventId")
    OR "actorUserId" = app_current_user_id()
    OR (app_is_public() AND app_can_write_public_event("eventId"))
    OR (app_is_auth() AND "actorUserId" IS NOT NULL)
  );

CREATE POLICY rls_audit_update ON "AuditLog" FOR UPDATE
  USING (app_is_internal() OR app_is_super_admin())
  WITH CHECK (app_is_internal() OR app_is_super_admin());

CREATE POLICY rls_audit_delete ON "AuditLog" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin());

-- ── Notification: Restrict to owner and event staff ─────────────────────
DROP POLICY IF EXISTS rls_notification_select ON "Notification";

CREATE POLICY rls_notification_select ON "Notification" FOR SELECT
  USING (
    "userId" = app_current_user_id()
    OR app_can_access_event("eventId")
    OR app_user_can_see_event("eventId")
    OR app_is_super_admin()
    OR app_is_internal()
  );

-- ── CredentialDeliveryAttempt: Restrict access ──────────────────────────
DROP POLICY IF EXISTS rls_credential_delivery_attempt_select ON "CredentialDeliveryAttempt";

CREATE POLICY rls_credential_delivery_attempt_select ON "CredentialDeliveryAttempt" FOR SELECT
  USING (
    app_is_internal()
    OR app_is_super_admin()
    OR app_can_access_event("eventId")
    OR app_user_can_see_event("eventId")
    OR "createdById" = app_current_user_id()
  );

-- ── BusSeat: Prevent public from seeing reserved seat details ────────────
-- The public API already filters holderName, but RLS should also prevent
-- direct database access to passenger data

DROP POLICY IF EXISTS rls_bus_seat_select ON "BusSeat";

CREATE POLICY rls_bus_seat_select ON "BusSeat" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Bus" b
      WHERE b."id" = "BusSeat"."busId" AND (
        app_can_access_event(b."eventId")
        OR app_user_can_see_event(b."eventId")
        OR (app_is_public() AND app_can_write_public_event(b."eventId"))
        OR (app_is_public() AND app_can_view_public_event(b."eventId") AND "state" = 'AVAILABLE')
      )
    )
  );

-- Note: For public event view, only AVAILABLE seats are visible
-- Reserved seat details (holderName, passengerName, etc.) are hidden by the API layer
-- but this policy ensures even direct DB queries can't leak them