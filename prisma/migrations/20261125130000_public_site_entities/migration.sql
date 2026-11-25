-- The public-site models were present in Prisma schema but had no
-- physical migration. Create them before site-content seeding references reviews.

SELECT set_config('app.is_internal', 'true', false);

CREATE TABLE IF NOT EXISTS "PublicReview" (
  "id" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "role" TEXT,
  "content" TEXT NOT NULL,
  "rating" INTEGER NOT NULL DEFAULT 5,
  "eventName" TEXT,
  "visible" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicReview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PublicReview_visible_idx" ON "PublicReview"("visible");

CREATE TABLE IF NOT EXISTS "ContactMessage" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "orgName" TEXT,
  "eventType" TEXT,
  "eventDate" TEXT,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ContactMessage_status_idx" ON "ContactMessage"("status");

CREATE TABLE IF NOT EXISTS "WheelSpin" (
  "id" TEXT NOT NULL,
  "ip" TEXT NOT NULL,
  "spins" INTEGER NOT NULL DEFAULT 0,
  "lastReward" TEXT,
  "lastLabel" TEXT,
  "lastCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WheelSpin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WheelSpin_ip_key" ON "WheelSpin"("ip");

DROP POLICY IF EXISTS rls_public_review_select ON "PublicReview";
DROP POLICY IF EXISTS rls_public_review_write ON "PublicReview";
ALTER TABLE "PublicReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublicReview" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_public_review_select ON "PublicReview" FOR SELECT
  USING (app_is_internal() OR app_is_super_admin() OR (app_is_public() AND "visible"));
CREATE POLICY rls_public_review_write ON "PublicReview" FOR ALL
  USING (app_is_internal() OR app_is_super_admin())
  WITH CHECK (app_is_internal() OR app_is_super_admin());

DROP POLICY IF EXISTS rls_contact_read ON "ContactMessage";
DROP POLICY IF EXISTS rls_contact_insert_returning ON "ContactMessage";
DROP POLICY IF EXISTS rls_contact_insert ON "ContactMessage";
DROP POLICY IF EXISTS rls_contact_write ON "ContactMessage";
ALTER TABLE "ContactMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactMessage" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_contact_read ON "ContactMessage" FOR SELECT
  USING (app_is_internal() OR app_is_super_admin());
CREATE POLICY rls_contact_insert_returning ON "ContactMessage" FOR SELECT
  USING (app_is_public() AND "id" = app_setting('app.contact_id'));
CREATE POLICY rls_contact_insert ON "ContactMessage" FOR INSERT
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_is_public());
CREATE POLICY rls_contact_write ON "ContactMessage" FOR ALL
  USING (app_is_internal() OR app_is_super_admin())
  WITH CHECK (app_is_internal() OR app_is_super_admin());

DROP POLICY IF EXISTS rls_wheel_select ON "WheelSpin";
DROP POLICY IF EXISTS rls_wheel_insert ON "WheelSpin";
DROP POLICY IF EXISTS rls_wheel_update ON "WheelSpin";
DROP POLICY IF EXISTS rls_wheel_delete ON "WheelSpin";
ALTER TABLE "WheelSpin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WheelSpin" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_wheel_select ON "WheelSpin" FOR SELECT
  USING (app_is_internal() OR app_is_super_admin() OR app_is_public());
CREATE POLICY rls_wheel_insert ON "WheelSpin" FOR INSERT
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_is_public());
CREATE POLICY rls_wheel_update ON "WheelSpin" FOR UPDATE
  USING (app_is_internal() OR app_is_super_admin() OR app_is_public())
  WITH CHECK (app_is_internal() OR app_is_super_admin() OR app_is_public());
CREATE POLICY rls_wheel_delete ON "WheelSpin" FOR DELETE
  USING (app_is_internal() OR app_is_super_admin());
