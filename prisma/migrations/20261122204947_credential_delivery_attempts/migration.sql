-- CreateTable
CREATE TABLE "CredentialDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "credentialId" TEXT,
    "channel" "DeliveryChannel" NOT NULL DEFAULT 'EMAIL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "recipient" TEXT,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CredentialDeliveryAttempt_eventId_createdAt_idx" ON "CredentialDeliveryAttempt"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "CredentialDeliveryAttempt_ticketId_createdAt_idx" ON "CredentialDeliveryAttempt"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "CredentialDeliveryAttempt_credentialId_idx" ON "CredentialDeliveryAttempt"("credentialId");

-- CreateIndex
CREATE INDEX "CredentialDeliveryAttempt_status_idx" ON "CredentialDeliveryAttempt"("status");

-- AddForeignKey
ALTER TABLE "CredentialDeliveryAttempt" ADD CONSTRAINT "CredentialDeliveryAttempt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialDeliveryAttempt" ADD CONSTRAINT "CredentialDeliveryAttempt_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialDeliveryAttempt" ADD CONSTRAINT "CredentialDeliveryAttempt_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialDeliveryAttempt" ADD CONSTRAINT "CredentialDeliveryAttempt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
