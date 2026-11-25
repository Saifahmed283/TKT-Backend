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
