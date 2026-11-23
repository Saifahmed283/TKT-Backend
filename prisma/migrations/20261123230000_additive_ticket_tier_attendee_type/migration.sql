-- Additive SAC rationalization: normalized tier/type fields (compatibility-safe)
DO $$ BEGIN
  CREATE TYPE "TicketTier" AS ENUM ('STANDARD','VIP','PREMIUM','EARLY_BIRD','STUDENT','COMPLIMENTARY','STAFF','SPEAKER','SPONSOR','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AttendeeType" AS ENUM ('ATTENDEE','VIP','SPEAKER','SPONSOR','EXHIBITOR','MEDIA','STAFF','ORGANIZER','STUDENT','GUEST','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "tier" "TicketTier";
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "attendeeType" "AttendeeType";

CREATE INDEX IF NOT EXISTS "TicketType_eventId_tier_idx" ON "TicketType"("eventId", "tier");
CREATE INDEX IF NOT EXISTS "Attendee_eventId_attendeeType_idx" ON "Attendee"("eventId", "attendeeType");
