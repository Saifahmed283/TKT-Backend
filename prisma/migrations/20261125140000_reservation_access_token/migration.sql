-- Stores a hashed reservation access token for a future tokenized lookup.
-- Nullable so existing tickets and the current code+email status flow keep working.
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "accessTokenHash" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "accessTokenExpiresAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Ticket_accessTokenHash_idx" ON "Ticket"("accessTokenHash");
