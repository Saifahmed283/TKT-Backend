-- Postgres-backed fallback for sensitive-endpoint rate limits.
-- Upstash remains preferred when configured; this keeps production fail-closed
-- without requiring another credential.
CREATE TABLE IF NOT EXISTS "RateLimitCounter" (
  "key" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "RateLimitCounter_windowStart_idx"
  ON "RateLimitCounter"("windowStart");
