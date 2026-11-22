-- Phase C: device/network/scan ops

DO $$ BEGIN
  CREATE TYPE "DeviceStatus" AS ENUM ('REGISTERED', 'ACTIVE', 'DISABLED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DeviceType" AS ENUM ('MOBILE', 'TABLET', 'DESKTOP', 'KIOSK', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DeviceNetworkStatus" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Device"
  ADD COLUMN IF NOT EXISTS "type" "DeviceType" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN IF NOT EXISTS "status" "DeviceStatus" NOT NULL DEFAULT 'REGISTERED',
  ADD COLUMN IF NOT EXISTS "fingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "lastHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastIp" TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT,
  ADD COLUMN IF NOT EXISTS "appVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "networkStatus" "DeviceNetworkStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "metadata" JSONB,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "Device_eventId_status_idx" ON "Device"("eventId", "status");
CREATE INDEX IF NOT EXISTS "Device_ownerId_idx" ON "Device"("ownerId");
CREATE INDEX IF NOT EXISTS "Device_lastSeenAt_idx" ON "Device"("lastSeenAt");

DO $$ BEGIN
  ALTER TABLE "Device" ADD CONSTRAINT "Device_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AccessLog" ADD CONSTRAINT "AccessLog_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
