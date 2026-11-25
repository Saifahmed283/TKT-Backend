-- DropIndex
DROP INDEX IF EXISTS "BusSeat_ticketId_key";

-- CreateIndex
CREATE INDEX "BusSeat_ticketId_idx" ON "BusSeat"("ticketId");
