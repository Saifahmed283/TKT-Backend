-- CreateTable
CREATE TABLE "Bus" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "layout" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bus_pkey" PRIMARY KEY ("id")
);

-- CreateEnum
CREATE TYPE "SeatState" AS ENUM ('AVAILABLE', 'RESERVED', 'UNAVAILABLE');

-- CreateTable
CREATE TABLE "BusSeat" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "row" INTEGER NOT NULL,
    "col" INTEGER NOT NULL,
    "state" "SeatState" NOT NULL DEFAULT 'AVAILABLE',
    "ticketId" TEXT,
    "holderName" TEXT,
    "groupId" TEXT,
    "reservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusSeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bus_eventId_idx" ON "Bus"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "BusSeat_ticketId_key" ON "BusSeat"("ticketId");

-- CreateIndex
CREATE INDEX "BusSeat_busId_state_idx" ON "BusSeat"("busId", "state");

-- CreateIndex
CREATE INDEX "BusSeat_groupId_idx" ON "BusSeat"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "BusSeat_busId_row_col_key" ON "BusSeat"("busId", "row", "col");

-- AddForeignKey
ALTER TABLE "Bus" ADD CONSTRAINT "Bus_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusSeat" ADD CONSTRAINT "BusSeat_busId_fkey" FOREIGN KEY ("busId") REFERENCES "Bus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusSeat" ADD CONSTRAINT "BusSeat_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
