-- Query index pass: composite, partial, expression, and trigram indexes.
-- All statements are additive and idempotent; no existing index is dropped.
-- The partial reservation-unique index from 20261122195042 is intentionally preserved.

-- Event lists filter by status and sort by startAt together.
CREATE INDEX IF NOT EXISTS "Event_status_startAt_idx" ON "Event" ("status", "startAt");
CREATE INDEX IF NOT EXISTS "Event_orgId_startAt_idx" ON "Event" ("orgId", "startAt" DESC);

-- Attendee list/report filters and sorting.
CREATE INDEX IF NOT EXISTS "Attendee_eventId_status_idx" ON "Attendee" ("eventId", "status");
CREATE INDEX IF NOT EXISTS "Attendee_eventId_createdAt_idx" ON "Attendee" ("eventId", "createdAt" DESC);

-- Device presence and gate-heartbeat lookups.
CREATE INDEX IF NOT EXISTS "Device_eventId_lastSeenAt_idx" ON "Device" ("eventId", "lastSeenAt" DESC);

-- Area-scoped access-log feeds.
CREATE INDEX IF NOT EXISTS "AccessLog_eventId_areaId_timestamp_idx" ON "AccessLog" ("eventId", "areaId", "timestamp" DESC);

-- Credential admin lists.
CREATE INDEX IF NOT EXISTS "Credential_eventId_issuedAt_idx" ON "Credential" ("eventId", "issuedAt" DESC);
CREATE INDEX IF NOT EXISTS "Credential_eventId_status_issuedAt_idx" ON "Credential" ("eventId", "status", "issuedAt" DESC);

-- Notification feeds.
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification" ("userId", "createdAt" DESC);

-- Ticket reporting and reservation resend lookups.
CREATE INDEX IF NOT EXISTS "Ticket_eventId_status_ticketTypeId_idx" ON "Ticket" ("eventId", "status", "ticketTypeId");
CREATE INDEX IF NOT EXISTS "Ticket_eventId_reservationEmail_issuedAt_idx"
  ON "Ticket" ("eventId", "reservationEmail", "issuedAt" DESC)
  WHERE "reservationEmail" IS NOT NULL;

-- Prisma JSON path filters compile to (metadata #> ARRAY['key']::text[])::jsonb.
CREATE INDEX IF NOT EXISTS "Ticket_metadata_channel_idx" ON "Ticket" (((metadata #> ARRAY['channel']::text[])::jsonb));
CREATE INDEX IF NOT EXISTS "Ticket_metadata_approval_idx" ON "Ticket" (((metadata #> ARRAY['approval']::text[])::jsonb));
CREATE INDEX IF NOT EXISTS "Ticket_metadata_payment_reference_idx" ON "Ticket" (((metadata #> ARRAY['paymentReference']::text[])::jsonb));
CREATE INDEX IF NOT EXISTS "Ticket_metadata_reservation_code_idx" ON "Ticket" (((metadata #> ARRAY['reservationCode']::text[])::jsonb));
CREATE INDEX IF NOT EXISTS "Ticket_metadata_payment_status_idx" ON "Ticket" (((metadata #> ARRAY['paymentStatus']::text[])::jsonb));
CREATE INDEX IF NOT EXISTS "Ticket_metadata_approval_status_idx" ON "Ticket" (((metadata #> ARRAY['approvalStatus']::text[])::jsonb));

-- Schema drift: BusSeat.ticketId lookups had a physical migration but no declaration.
CREATE INDEX IF NOT EXISTS "BusSeat_ticketId_idx" ON "BusSeat" ("ticketId");

-- Substring/case-insensitive search cannot use B-tree indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Attendee_name_trgm_idx" ON "Attendee" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Attendee_email_trgm_idx" ON "Attendee" USING GIN ("email" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Attendee_phone_trgm_idx" ON "Attendee" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Ticket_reservation_email_trgm_idx" ON "Ticket" USING GIN ("reservationEmail" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Ticket_reservation_name_trgm_idx" ON "Ticket" USING GIN ("reservationName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Ticket_reservation_code_trgm_idx" ON "Ticket" USING GIN ("reservationCode" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Event_name_trgm_idx" ON "Event" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Event_venue_trgm_idx" ON "Event" USING GIN ("venueName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "User_email_lower_trgm_idx" ON "User" USING GIN (lower("email") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "User_name_trgm_idx" ON "User" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Credential_code_trgm_idx" ON "Credential" USING GIN ("code" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Credential_short_code_trgm_idx" ON "Credential" USING GIN ("shortCode" gin_trgm_ops);
