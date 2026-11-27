-- TKT-PASS: event designs, per-ticket pass state and pass issuance outbox event.

ALTER TYPE "OutboxEventType" ADD VALUE IF NOT EXISTS 'PASS_ISSUED';

CREATE TYPE "PassDesignStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "PassIssueStatus" AS ENUM ('NOT_ISSUED', 'ISSUED', 'DELIVERED', 'FAILED', 'REVOKED');

ALTER TABLE "OrganizationFolder" ADD COLUMN "settings" JSONB;

CREATE TABLE "PassDesign" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "PassDesignStatus" NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PassDesign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PassDesign_eventId_key" ON "PassDesign"("eventId");
CREATE INDEX "PassDesign_orgId_status_idx" ON "PassDesign"("orgId", "status");

ALTER TABLE "PassDesign" ADD CONSTRAINT "PassDesign_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PassDesign" ADD CONSTRAINT "PassDesign_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Ticket"
    ADD COLUMN "passDesignId" TEXT,
    ADD COLUMN "passIssueStatus" "PassIssueStatus" NOT NULL DEFAULT 'NOT_ISSUED',
    ADD COLUMN "passConfig" JSONB,
    ADD COLUMN "passSessionId" TEXT,
    ADD COLUMN "passTokenHash" TEXT,
    ADD COLUMN "passTokenExpiresAt" TIMESTAMP(3),
    ADD COLUMN "passIssuedAt" TIMESTAMP(3),
    ADD COLUMN "passOpenedAt" TIMESTAMP(3),
    ADD COLUMN "passCustomizedAt" TIMESTAMP(3),
    ADD COLUMN "passLastDeliveryAt" TIMESTAMP(3),
    ADD COLUMN "passDeliveryAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Ticket_passSessionId_key" ON "Ticket"("passSessionId");
CREATE UNIQUE INDEX "Ticket_passTokenHash_key" ON "Ticket"("passTokenHash");
CREATE INDEX "Ticket_passDesignId_passIssueStatus_idx" ON "Ticket"("passDesignId", "passIssueStatus");
CREATE INDEX "Ticket_eventId_passIssueStatus_idx" ON "Ticket"("eventId", "passIssueStatus");

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_passDesignId_fkey" FOREIGN KEY ("passDesignId") REFERENCES "PassDesign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Pass designs follow the same organization/event RLS model as events.
ALTER TABLE "PassDesign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PassDesign" FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_pass_design_all ON "PassDesign" FOR ALL
  USING (
    app_is_internal() OR app_is_super_admin()
    OR app_can_access_org("orgId")
    OR app_can_access_event("eventId")
  )
  WITH CHECK (
    app_is_internal() OR app_is_super_admin()
    OR app_can_access_org("orgId")
    OR app_can_access_event("eventId")
  );

CREATE POLICY rls_pass_design_public_deny ON "PassDesign" AS RESTRICTIVE FOR ALL
  USING (NOT app_is_public())
  WITH CHECK (NOT app_is_public());
