-- AlterTable
ALTER TABLE "Event" ADD COLUMN "category" TEXT;

-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN "category" TEXT,
ADD COLUMN "salesStartAt" TIMESTAMP(3),
ADD COLUMN "salesEndAt" TIMESTAMP(3),
ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "TicketType_eventId_active_isPublic_idx" ON "TicketType"("eventId", "active", "isPublic");
