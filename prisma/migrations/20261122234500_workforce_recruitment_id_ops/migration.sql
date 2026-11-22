-- Phase D: workforce / recruitment / ID ops

DO $$ BEGIN
  CREATE TYPE "WorkforceApplicationStatus" AS ENUM ('PENDING','REVIEWING','APPROVED','REJECTED','CONVERTED','WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StaffProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "eventId" TEXT,
  "nationalId" TEXT,
  "workerCode" TEXT,
  "title" TEXT,
  "department" TEXT,
  "phoneSecondary" TEXT,
  "emergencyContact" TEXT,
  "notes" TEXT,
  "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
  "idCardIssuedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WorkforceApplication" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "nationalId" TEXT,
  "requestedRoleCode" TEXT,
  "requestedTeamId" TEXT,
  "requestedAreaIds" JSONB,
  "source" TEXT DEFAULT 'manual',
  "status" "WorkforceApplicationStatus" NOT NULL DEFAULT 'PENDING',
  "notes" TEXT,
  "reviewNotes" TEXT,
  "submittedById" TEXT,
  "reviewedById" TEXT,
  "convertedUserId" TEXT,
  "convertedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkforceApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StaffProfile_userId_key" ON "StaffProfile"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "StaffProfile_workerCode_key" ON "StaffProfile"("workerCode");
CREATE INDEX IF NOT EXISTS "StaffProfile_eventId_idx" ON "StaffProfile"("eventId");

CREATE INDEX IF NOT EXISTS "WorkforceApplication_eventId_status_idx" ON "WorkforceApplication"("eventId","status");
CREATE INDEX IF NOT EXISTS "WorkforceApplication_eventId_email_idx" ON "WorkforceApplication"("eventId","email");
CREATE INDEX IF NOT EXISTS "WorkforceApplication_requestedRoleCode_idx" ON "WorkforceApplication"("requestedRoleCode");

DO $$ BEGIN
  ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "WorkforceApplication" ADD CONSTRAINT "WorkforceApplication_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "WorkforceApplication" ADD CONSTRAINT "WorkforceApplication_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "WorkforceApplication" ADD CONSTRAINT "WorkforceApplication_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
