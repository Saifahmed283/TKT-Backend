-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';

-- CreateEnum
CREATE TYPE "AccessCodeType" AS ENUM ('VIP_GUEST', 'VIP_TICKET', 'INVITE', 'COMP');

-- CreateEnum
CREATE TYPE "AccessCodeStatus" AS ENUM ('ACTIVE', 'REDEEMED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "AccessCode" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "AccessCodeType" NOT NULL DEFAULT 'VIP_GUEST',
    "status" "AccessCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "fullName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "attendeeCategory" TEXT,
    "ticketTypeId" TEXT,
    "notes" TEXT,
    "maxRedemptions" INTEGER NOT NULL DEFAULT 1,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "lastRedeemedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "redeemedByAttendeeId" TEXT,
    "redeemedTicketId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessCode_code_key" ON "AccessCode"("code");
CREATE INDEX "AccessCode_eventId_status_idx" ON "AccessCode"("eventId", "status");
CREATE INDEX "AccessCode_eventId_type_idx" ON "AccessCode"("eventId", "type");
CREATE INDEX "AccessCode_ticketTypeId_idx" ON "AccessCode"("ticketTypeId");
CREATE INDEX "AccessCode_redeemedByAttendeeId_idx" ON "AccessCode"("redeemedByAttendeeId");
CREATE INDEX "AccessCode_redeemedTicketId_idx" ON "AccessCode"("redeemedTicketId");

-- AddForeignKey
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_redeemedByAttendeeId_fkey" FOREIGN KEY ("redeemedByAttendeeId") REFERENCES "Attendee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_redeemedTicketId_fkey" FOREIGN KEY ("redeemedTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
