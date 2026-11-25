-- Stores replayable responses for idempotent mutation requests.
CREATE TABLE IF NOT EXISTS "IdempotencyKey" (
  "id" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyKey_keyHash_key"
  ON "IdempotencyKey"("keyHash");

CREATE INDEX IF NOT EXISTS "IdempotencyKey_expiresAt_idx"
  ON "IdempotencyKey"("expiresAt");
