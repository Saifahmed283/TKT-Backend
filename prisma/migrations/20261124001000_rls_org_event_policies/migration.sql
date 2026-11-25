-- Enable RLS on every application table. Migration sessions remain internal.
SELECT set_config('app.is_internal', 'true', false);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User', 'Organization', 'OrganizationMember', 'OrganizationFolder', 'Role',
    'Event', 'EventMember', 'Team', 'Area', 'MemberArea', 'TeamArea',
    'Attendee', 'TicketType', 'PaymentProvider', 'AccessCode', 'Ticket',
    'Credential', 'AccessLog', 'Device', 'Task', 'TaskActivity', 'Incident',
    'IncidentComment', 'Announcement', 'Message', 'Notification', 'PublicReview',
    'ContactMessage', 'WheelSpin', 'CredentialDeliveryAttempt', 'StaffProfile',
    'WorkforceApplication', 'WebhookSubscription', 'WebhookDelivery',
    'EventInsurancePolicy', 'EventMapAsset', 'OpsAlert', 'TeamChatMessage',
    'AuditLog', 'Bus', 'BusSeat'
  ] LOOP
    -- Some public-site entities are introduced by later migrations.
    -- Enable RLS only when the relation exists at this point in the chain.
    IF to_regclass(format('%I.%I', 'public', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- ── Users ─────────────────────────────────────────────────────────────
-- app_is_auth() is only set on /auth/* routes, where login/register must find
-- users before a user id is available in the context.
CREATE POLICY rls_user_select ON "User" FOR SELECT
  USING (
    app_is_internal() OR app_is_super_admin() OR app_is_auth()
    OR "id" = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM "OrganizationMember" om
      WHERE om."userId" = "User"."id" AND (
        app_can_access_org(om."orgId") OR app_user_can_see_org(om."orgId")
      )
    )
    OR EXISTS (
      SELECT 1 FROM "EventMember" em
      WHERE em."userId" = "User"."id" AND (
        app_can_access_event(em."eventId") OR app_user_can_see_event(em."eventId")
      )
    )
    OR app_user_admin_org(app_current_org_id())
  );

CREATE POLICY rls_user_insert ON "User" FOR INSERT
  WITH CHECK (
    app_is_internal() OR app_is_super_admin() OR app_is_auth()
    OR app_user_admin_org(app_current_org_id())
  );

CREATE POLICY rls_user_update ON "User" FOR UPDATE
  USING (
    app_is_internal() OR app_is_super_admin()
    OR "id" = app_current_user_id()
    OR app_user_admin_org(app_current_org_id())
  )
  WITH CHECK (
    app_is_internal() OR app_is_super_admin()
    OR "id" = app_current_user_id()
    OR app_user_admin_org(app_current_org_id())
  );

CREATE POLICY rls_user_delete ON "User" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin() OR app_user_admin_org(app_current_org_id()));

-- ── Organizations ─────────────────────────────────────────────────────
CREATE POLICY rls_org_select ON "Organization" FOR SELECT
  USING (
    app_can_access_org("id")
    OR app_user_can_see_org("id")
    OR (
      app_is_public()
      AND (
        "status" = 'ACTIVE'
        OR EXISTS (
          SELECT 1 FROM "Event" e
          WHERE e."orgId" = "Organization"."id"
            AND e."status" IN ('PUBLISHED', 'LIVE', 'COMPLETED', 'ARCHIVED')
        )
      )
    )
  );

CREATE POLICY rls_org_insert ON "Organization" FOR INSERT
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_current_user_id() IS NOT NULL);

CREATE POLICY rls_org_update ON "Organization" FOR UPDATE
  USING (app_is_internal() OR app_is_super_admin() OR app_can_access_org("id"))
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_can_access_org("id"));

CREATE POLICY rls_org_delete ON "Organization" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin() OR app_can_access_org("id"));

-- ── Organization members and folders ──────────────────────────────────
CREATE POLICY rls_org_member_select ON "OrganizationMember" FOR SELECT
  USING (app_can_access_org("orgId") OR app_user_can_see_org("orgId"));

CREATE POLICY rls_org_member_insert ON "OrganizationMember" FOR INSERT
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_can_access_org("orgId") OR app_user_admin_org("orgId"));

CREATE POLICY rls_org_member_update ON "OrganizationMember" FOR UPDATE
  USING (app_is_internal() OR app_is_super_admin() OR app_can_access_org("orgId") OR app_user_admin_org("orgId"))
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_can_access_org("orgId") OR app_user_admin_org("orgId"));

CREATE POLICY rls_org_member_delete ON "OrganizationMember" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin() OR app_can_access_org("orgId") OR app_user_admin_org("orgId"));

CREATE POLICY rls_org_folder_all ON "OrganizationFolder" FOR ALL
  USING (app_can_access_org("orgId"))
  WITH CHECK (app_can_access_org("orgId"));

-- ── Roles ─────────────────────────────────────────────────────────────
CREATE POLICY rls_role_select ON "Role" FOR SELECT
  USING ("orgId" IS NULL OR app_can_access_org("orgId") OR app_user_can_see_org("orgId"));

CREATE POLICY rls_role_write ON "Role" FOR ALL
  USING (
    app_is_internal() OR app_is_super_admin()
    OR ("orgId" IS NOT NULL AND app_user_admin_org("orgId"))
  )
  WITH CHECK (
    app_is_internal() OR app_is_super_admin()
    OR ("orgId" IS NOT NULL AND app_user_admin_org("orgId"))
  );

-- ── Events ────────────────────────────────────────────────────────────
CREATE POLICY rls_event_select ON "Event" FOR SELECT
  USING (
    app_can_access_org("orgId")
    OR app_can_access_event("id")
    OR app_user_can_see_event("id")
    OR app_user_can_see_org("orgId")
    OR (app_is_public() AND "status" IN ('PUBLISHED', 'LIVE', 'COMPLETED', 'ARCHIVED'))
  );

CREATE POLICY rls_event_insert ON "Event" FOR INSERT
  WITH CHECK (
    app_is_internal() OR app_is_super_admin() OR app_can_access_org("orgId")
  );

CREATE POLICY rls_event_update ON "Event" FOR UPDATE
  USING (
    app_is_internal() OR app_is_super_admin()
    OR app_can_access_org("orgId")
    OR app_can_access_event("id")
    OR app_can_write_public_event("id")
  )
  WITH CHECK (
    app_is_internal() OR app_is_super_admin()
    OR app_can_access_org("orgId")
    OR app_can_access_event("id")
    OR app_can_write_public_event("id")
  );

CREATE POLICY rls_event_delete ON "Event" FOR DELETE
  USING (
    app_is_internal() OR app_is_super_admin()
    OR app_can_access_org("orgId")
    OR app_can_access_event("id")
  );

-- ── Event members ─────────────────────────────────────────────────────
CREATE POLICY rls_event_member_select ON "EventMember" FOR SELECT
  USING (app_can_access_event("eventId") OR app_user_can_see_event("eventId"));

CREATE POLICY rls_event_member_insert ON "EventMember" FOR INSERT
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_can_access_event("eventId"));

CREATE POLICY rls_event_member_update ON "EventMember" FOR UPDATE
  USING (app_is_internal() OR app_is_super_admin() OR app_can_access_event("eventId"))
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_can_access_event("eventId"));

CREATE POLICY rls_event_member_delete ON "EventMember" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin() OR app_can_access_event("eventId"));

-- ── Direct event-scoped tables ────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Team', 'Area', 'Attendee', 'TicketType', 'PaymentProvider', 'AccessCode',
    'Ticket', 'Credential', 'AccessLog', 'Task', 'Incident', 'Announcement',
    'Message', 'CredentialDeliveryAttempt', 'WorkforceApplication',
    'WebhookSubscription', 'EventInsurancePolicy', 'EventMapAsset', 'OpsAlert',
    'TeamChatMessage', 'Bus'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY rls_event_direct_select ON %I FOR SELECT USING (app_can_access_event("eventId") OR app_user_can_see_event("eventId") OR app_can_view_public_event("eventId"))',
      t
    );
    EXECUTE format(
      'CREATE POLICY rls_event_direct_insert ON %I FOR INSERT WITH CHECK (app_can_access_event("eventId") OR app_can_write_public_event("eventId"))',
      t
    );
    EXECUTE format(
      'CREATE POLICY rls_event_direct_update ON %I FOR UPDATE USING (app_can_access_event("eventId") OR app_can_write_public_event("eventId")) WITH CHECK (app_can_access_event("eventId") OR app_can_write_public_event("eventId"))',
      t
    );
    EXECUTE format(
      'CREATE POLICY rls_event_direct_delete ON %I FOR DELETE USING (app_can_access_event("eventId") OR app_can_write_public_event("eventId"))',
      t
    );
  END LOOP;
END $$;

-- Public callers must not be able to enumerate credentials, access codes or
-- webhook subscriptions for published events. Narrow these reads to the event
-- explicitly named in the URL.
CREATE POLICY rls_public_credential_read ON "Credential" AS RESTRICTIVE FOR SELECT
  USING (NOT app_is_public() OR app_can_write_public_event("eventId"));

CREATE POLICY rls_public_access_code_read ON "AccessCode" AS RESTRICTIVE FOR SELECT
  USING (NOT app_is_public() OR app_can_write_public_event("eventId"));

CREATE POLICY rls_public_webhook_read ON "WebhookSubscription" AS RESTRICTIVE FOR SELECT
  USING (NOT app_is_public() OR app_can_write_public_event("eventId"));

-- Public routes never write to these tables. Restrictive policies block any
-- public write even though the generic event loop grants event-scoped writes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User', 'Organization', 'OrganizationMember', 'OrganizationFolder', 'Role',
    'EventMember', 'Team', 'Area', 'MemberArea', 'TeamArea', 'Device', 'Task',
    'TaskActivity', 'Incident', 'IncidentComment', 'Announcement', 'Message',
    'Notification', 'StaffProfile', 'WorkforceApplication', 'WebhookSubscription',
    'EventInsurancePolicy', 'EventMapAsset', 'OpsAlert', 'TeamChatMessage'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY rls_no_public_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (NOT app_is_public())',
      t
    );
    EXECUTE format(
      'CREATE POLICY rls_no_public_update ON %I AS RESTRICTIVE FOR UPDATE USING (NOT app_is_public())',
      t
    );
    EXECUTE format(
      'CREATE POLICY rls_no_public_delete ON %I AS RESTRICTIVE FOR DELETE USING (NOT app_is_public())',
      t
    );
  END LOOP;
END $$;

-- ── Special event-scoped tables ───────────────────────────────────────
CREATE POLICY rls_public_device_read ON "Device" AS RESTRICTIVE FOR SELECT
  USING (NOT app_is_public());

CREATE POLICY rls_device_select ON "Device" FOR SELECT
  USING (
    app_can_access_event("eventId") OR app_user_can_see_event("eventId")
    OR "ownerId" = app_current_user_id()
  );

CREATE POLICY rls_device_insert ON "Device" FOR INSERT
  WITH CHECK (app_can_access_event("eventId") OR "ownerId" = app_current_user_id());

CREATE POLICY rls_device_update ON "Device" FOR UPDATE
  USING (app_can_access_event("eventId") OR "ownerId" = app_current_user_id())
  WITH CHECK (app_can_access_event("eventId") OR "ownerId" = app_current_user_id());

CREATE POLICY rls_device_delete ON "Device" FOR DELETE
  USING (app_can_access_event("eventId") OR "ownerId" = app_current_user_id());

CREATE POLICY rls_notification_select ON "Notification" FOR SELECT
  USING (
    "userId" = app_current_user_id()
    OR app_can_access_event("eventId")
    OR app_user_can_see_event("eventId")
  );

CREATE POLICY rls_notification_insert ON "Notification" FOR INSERT
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR "userId" = app_current_user_id() OR app_can_access_event("eventId"));

CREATE POLICY rls_notification_update ON "Notification" FOR UPDATE
  USING (app_is_internal() OR app_is_super_admin() OR "userId" = app_current_user_id())
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR "userId" = app_current_user_id());

CREATE POLICY rls_notification_delete ON "Notification" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin() OR "userId" = app_current_user_id());

CREATE POLICY rls_staff_profile_select ON "StaffProfile" FOR SELECT
  USING (
    "userId" = app_current_user_id()
    OR app_can_access_event("eventId")
    OR app_user_can_see_event("eventId")
  );

CREATE POLICY rls_staff_profile_insert ON "StaffProfile" FOR INSERT
  WITH CHECK ("userId" = app_current_user_id() OR app_can_access_event("eventId"));

CREATE POLICY rls_staff_profile_update ON "StaffProfile" FOR UPDATE
  USING ("userId" = app_current_user_id() OR app_can_access_event("eventId"))
  WITH CHECK ("userId" = app_current_user_id() OR app_can_access_event("eventId"));

CREATE POLICY rls_staff_profile_delete ON "StaffProfile" FOR DELETE
  USING ("userId" = app_current_user_id() OR app_can_access_event("eventId"));

-- ── Audit log ─────────────────────────────────────────────────────────
CREATE POLICY rls_audit_select ON "AuditLog" FOR SELECT
  USING (
    app_can_access_org("organizationId")
    OR app_can_access_event("eventId")
    OR "actorUserId" = app_current_user_id()
    OR (app_is_public() AND app_can_write_public_event("eventId"))
    OR app_is_auth()
  );

CREATE POLICY rls_audit_insert ON "AuditLog" FOR INSERT
  WITH CHECK (
    app_can_access_org("organizationId")
    OR app_can_access_event("eventId")
    OR "actorUserId" = app_current_user_id()
    OR (app_is_public() AND app_can_write_public_event("eventId"))
    OR (app_is_auth() AND "actorUserId" IS NOT NULL)
  );

CREATE POLICY rls_audit_delete ON "AuditLog" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin());

-- ── Child tables without a direct eventId ────────────────────────────
CREATE POLICY rls_member_area_select ON "MemberArea" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "EventMember" em
      WHERE em."id" = "MemberArea"."eventMemberId"
        AND (
          app_can_access_event(em."eventId")
          OR em."userId" = app_current_user_id()
          OR app_user_can_see_event(em."eventId")
        )
    )
  );

CREATE POLICY rls_member_area_write ON "MemberArea" FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "EventMember" em
      WHERE em."id" = "MemberArea"."eventMemberId" AND app_can_access_event(em."eventId")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "EventMember" em
      WHERE em."id" = "MemberArea"."eventMemberId" AND app_can_access_event(em."eventId")
    )
  );

CREATE POLICY rls_team_area_select ON "TeamArea" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "TeamArea"."teamId" AND (
        app_can_access_event(t."eventId")
        OR app_user_can_see_event(t."eventId")
        OR app_can_view_public_event(t."eventId")
      )
    )
  );

CREATE POLICY rls_team_area_write ON "TeamArea" FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "TeamArea"."teamId" AND app_can_access_event(t."eventId")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "TeamArea"."teamId" AND app_can_access_event(t."eventId")
    )
  );

CREATE POLICY rls_task_activity_select ON "TaskActivity" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Task" t
      WHERE t."id" = "TaskActivity"."taskId" AND (
        app_can_access_event(t."eventId") OR app_user_can_see_event(t."eventId")
      )
    )
  );

CREATE POLICY rls_task_activity_write ON "TaskActivity" FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "Task" t
      WHERE t."id" = "TaskActivity"."taskId" AND app_can_access_event(t."eventId")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Task" t
      WHERE t."id" = "TaskActivity"."taskId" AND app_can_access_event(t."eventId")
    )
  );

CREATE POLICY rls_incident_comment_select ON "IncidentComment" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Incident" i
      WHERE i."id" = "IncidentComment"."incidentId" AND (
        app_can_access_event(i."eventId") OR app_user_can_see_event(i."eventId")
      )
    )
  );

CREATE POLICY rls_incident_comment_write ON "IncidentComment" FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "Incident" i
      WHERE i."id" = "IncidentComment"."incidentId" AND app_can_access_event(i."eventId")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Incident" i
      WHERE i."id" = "IncidentComment"."incidentId" AND app_can_access_event(i."eventId")
    )
  );

CREATE POLICY rls_webhook_delivery_select ON "WebhookDelivery" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "WebhookSubscription" w
      WHERE w."id" = "WebhookDelivery"."subscriptionId" AND (
        app_can_access_event(w."eventId") OR app_user_can_see_event(w."eventId")
      )
    )
  );

CREATE POLICY rls_webhook_delivery_write ON "WebhookDelivery" FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "WebhookSubscription" w
      WHERE w."id" = "WebhookDelivery"."subscriptionId" AND (
        app_can_access_event(w."eventId") OR app_can_write_public_event(w."eventId")
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "WebhookSubscription" w
      WHERE w."id" = "WebhookDelivery"."subscriptionId" AND (
        app_can_access_event(w."eventId") OR app_can_write_public_event(w."eventId")
      )
    )
  );

CREATE POLICY rls_bus_seat_select ON "BusSeat" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Bus" b
      WHERE b."id" = "BusSeat"."busId" AND (
        app_can_access_event(b."eventId")
        OR app_user_can_see_event(b."eventId")
        OR app_can_view_public_event(b."eventId")
      )
    )
  );

CREATE POLICY rls_bus_seat_insert ON "BusSeat" FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Bus" b
      WHERE b."id" = "BusSeat"."busId" AND (
        app_can_access_event(b."eventId") OR app_can_write_public_event(b."eventId")
      )
    )
  );

CREATE POLICY rls_bus_seat_update ON "BusSeat" FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "Bus" b
      WHERE b."id" = "BusSeat"."busId" AND (
        app_can_access_event(b."eventId") OR app_can_write_public_event(b."eventId")
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Bus" b
      WHERE b."id" = "BusSeat"."busId" AND (
        app_can_access_event(b."eventId") OR app_can_write_public_event(b."eventId")
      )
    )
  );

CREATE POLICY rls_bus_seat_delete ON "BusSeat" FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "Bus" b
      WHERE b."id" = "BusSeat"."busId" AND app_can_access_event(b."eventId")
    )
  );

-- ── Public-only tables ────────────────────────────────────────────────
-- Public-site entities may be introduced by later migrations. Guard policy
-- creation so a clean migration chain never references a table prematurely.
DO $rls$
BEGIN
  IF to_regclass('"PublicReview"') IS NOT NULL THEN
    EXECUTE $policy$
      CREATE POLICY rls_public_review_select ON "PublicReview" FOR SELECT
      USING (app_is_internal() OR app_is_super_admin() OR (app_is_public() AND "visible"))
    $policy$;
    EXECUTE $policy$
      CREATE POLICY rls_public_review_write ON "PublicReview" FOR ALL
      USING (app_is_internal() OR app_is_super_admin())
      WITH CHECK (app_is_internal() OR app_is_super_admin())
    $policy$;
  END IF;

  IF to_regclass('"ContactMessage"') IS NOT NULL THEN
    EXECUTE $policy$
      CREATE POLICY rls_contact_read ON "ContactMessage" FOR SELECT
      USING (app_is_internal() OR app_is_super_admin())
    $policy$;
    -- Prisma create uses INSERT ... RETURNING; expose only the row created by
    -- the current public request.
    EXECUTE $policy$
      CREATE POLICY rls_contact_insert_returning ON "ContactMessage" FOR SELECT
      USING (app_is_public() AND "id" = app_setting('app.contact_id'))
    $policy$;
    EXECUTE $policy$
      CREATE POLICY rls_contact_insert ON "ContactMessage" FOR INSERT
      WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_is_public())
    $policy$;
    EXECUTE $policy$
      CREATE POLICY rls_contact_write ON "ContactMessage" FOR ALL
      USING (app_is_internal() OR app_is_super_admin())
      WITH CHECK (app_is_internal() OR app_is_super_admin())
    $policy$;
  END IF;

  IF to_regclass('"WheelSpin"') IS NOT NULL THEN
    EXECUTE $policy$
      CREATE POLICY rls_wheel_select ON "WheelSpin" FOR SELECT
      USING (app_is_internal() OR app_is_super_admin() OR app_is_public())
    $policy$;
    EXECUTE $policy$
      CREATE POLICY rls_wheel_insert ON "WheelSpin" FOR INSERT
      WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_is_public())
    $policy$;
    EXECUTE $policy$
      CREATE POLICY rls_wheel_update ON "WheelSpin" FOR UPDATE
      USING (app_is_internal() OR app_is_super_admin() OR app_is_public())
      WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_is_public())
    $policy$;
    EXECUTE $policy$
      CREATE POLICY rls_wheel_delete ON "WheelSpin" FOR DELETE
      USING (app_is_internal() OR app_is_super_admin())
    $policy$;
  END IF;
END $rls$;
