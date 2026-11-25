-- Reconcile Prisma schema additions that were previously missing from
-- the checked-in migration history. This migration is additive and safe to
-- run on databases where one or more objects were provisioned manually.

-- ── Refresh sessions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RefreshSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userAgent" TEXT,
  "ipAddress" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RefreshSession_tokenHash_key"
  ON "RefreshSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "RefreshSession_userId_idx"
  ON "RefreshSession"("userId");
CREATE INDEX IF NOT EXISTS "RefreshSession_expiresAt_idx"
  ON "RefreshSession"("expiresAt");
CREATE INDEX IF NOT EXISTS "RefreshSession_revokedAt_idx"
  ON "RefreshSession"("revokedAt");

DO $$
BEGIN
  ALTER TABLE "RefreshSession"
    ADD CONSTRAINT "RefreshSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── Transactional outbox ──────────────────────────────────────────────────
DO $$
BEGIN
  CREATE TYPE "OutboxEventType" AS ENUM (
    'RESERVATION_CREATED',
    'RESERVATION_APPROVED',
    'RESERVATION_REJECTED',
    'PAYMENT_SUBMITTED',
    'PAYMENT_APPROVED',
    'PAYMENT_REJECTED',
    'CREDENTIAL_ISSUED',
    'EMAIL_SEND',
    'WEBHOOK_DISPATCH',
    'ACCESS_CODE_REDEEMED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "OutboxEventStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'DEAD_LETTER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "OutboxEvent" (
  "id" TEXT NOT NULL,
  "eventType" "OutboxEventType" NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "lastError" TEXT,
  "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OutboxEvent_status_scheduledAt_idx"
  ON "OutboxEvent"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "OutboxEvent_eventType_status_idx"
  ON "OutboxEvent"("eventType", "status");
CREATE INDEX IF NOT EXISTS "OutboxEvent_createdAt_idx"
  ON "OutboxEvent"("createdAt");

-- ── Ticket type sold counter ──────────────────────────────────────────────
ALTER TABLE "TicketType"
  ADD COLUMN IF NOT EXISTS "soldCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "TicketType" AS tt
SET "soldCount" = (
  SELECT COUNT(*)::INTEGER
  FROM "Ticket" AS t
  WHERE t."ticketTypeId" = tt."id"
    AND t."status" IN ('ISSUED', 'ACTIVE', 'CONSUMED')
)
WHERE tt."soldCount" = 0;

-- Both tables contain credentials or operational messages. Restrict them
-- to the internal worker context; auth routes use app_is_auth() for refresh
-- session rotation and lookup.
ALTER TABLE "RefreshSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_refresh_session_auth ON "RefreshSession" FOR ALL
  USING (app_is_internal() OR app_is_auth())
  WITH CHECK (app_is_internal() OR app_is_auth());

ALTER TABLE "OutboxEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboxEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_outbox_internal ON "OutboxEvent";
DROP POLICY IF EXISTS rls_outbox_select ON "OutboxEvent";
DROP POLICY IF EXISTS rls_outbox_insert ON "OutboxEvent";
DROP POLICY IF EXISTS rls_outbox_update ON "OutboxEvent";
DROP POLICY IF EXISTS rls_outbox_delete ON "OutboxEvent";

CREATE POLICY rls_outbox_select ON "OutboxEvent" FOR SELECT
  USING (app_is_internal());
CREATE POLICY rls_outbox_insert ON "OutboxEvent" FOR INSERT
  WITH CHECK (app_is_internal() OR app_is_public());
CREATE POLICY rls_outbox_update ON "OutboxEvent" FOR UPDATE
  USING (app_is_internal())
  WITH CHECK (app_is_internal());
CREATE POLICY rls_outbox_delete ON "OutboxEvent" FOR DELETE
  USING (app_is_internal());

-- PostgreSQL also applies SELECT policies to INSERT ... RETURNING. A public
-- reservation can read back only the exact event ID it has just inserted.
CREATE POLICY rls_outbox_insert_returning ON "OutboxEvent" FOR SELECT
  USING (
    app_is_internal()
    OR (app_is_public() AND "id" = current_setting('app.outbox_event_id', true))
  );
