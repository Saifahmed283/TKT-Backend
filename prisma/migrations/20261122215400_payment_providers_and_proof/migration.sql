-- CreateTable
CREATE TABLE "PaymentProvider" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountName" TEXT,
    "accountNumber" TEXT,
    "paymentPhone" TEXT,
    "paymentLink" TEXT,
    "instructions" TEXT,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProvider_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "paymentAmount" DECIMAL(10,2),
ADD COLUMN "paymentProofUrl" TEXT,
ADD COLUMN "paymentProviderId" TEXT,
ADD COLUMN "paymentReviewNote" TEXT,
ADD COLUMN "paymentReviewedAt" TIMESTAMP(3),
ADD COLUMN "paymentReviewedById" TEXT,
ADD COLUMN "paymentSubmittedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PaymentProvider_eventId_isActive_idx" ON "PaymentProvider"("eventId", "isActive");

-- CreateIndex
CREATE INDEX "Ticket_paymentProviderId_idx" ON "Ticket"("paymentProviderId");

-- AddForeignKey
ALTER TABLE "PaymentProvider" ADD CONSTRAINT "PaymentProvider_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_paymentProviderId_fkey" FOREIGN KEY ("paymentProviderId") REFERENCES "PaymentProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_paymentReviewedById_fkey" FOREIGN KEY ("paymentReviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
