-- Phase E: event extras / integrations

DO $$ BEGIN
  CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING','SUCCESS','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "WebhookSubscription" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret" TEXT,
  "events" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "headers" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "responseCode" INTEGER,
  "responseBody" TEXT,
  "error" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EventInsurancePolicy" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "policyNumber" TEXT NOT NULL,
  "coverageDetails" TEXT,
  "incidentReport" TEXT,
  "claimStatus" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EventInsurancePolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EventMapAsset" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "map3dUrl" TEXT,
  "mapImageUrl" TEXT,
  "mapPdfUrl" TEXT,
  "routeNotes" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EventMapAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebhookSubscription_eventId_active_idx" ON "WebhookSubscription"("eventId","active");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_subscriptionId_createdAt_idx" ON "WebhookDelivery"("subscriptionId","createdAt");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");
CREATE INDEX IF NOT EXISTS "EventInsurancePolicy_eventId_idx" ON "EventInsurancePolicy"("eventId");
CREATE UNIQUE INDEX IF NOT EXISTS "EventMapAsset_eventId_key" ON "EventMapAsset"("eventId");

DO $$ BEGIN ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "EventInsurancePolicy" ADD CONSTRAINT "EventInsurancePolicy_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "EventMapAsset" ADD CONSTRAINT "EventMapAsset_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
