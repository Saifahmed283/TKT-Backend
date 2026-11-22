-- Reservation integrity: explicit approval/payment/delivery state on Ticket

CREATE TYPE "ReservationApprovalStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "ReservationPaymentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED');
CREATE TYPE "DeliveryChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'BOTH');

ALTER TABLE "Ticket"
  ADD COLUMN "reservationCode" TEXT,
  ADD COLUMN "reservationEmail" TEXT,
  ADD COLUMN "reservationPhone" TEXT,
  ADD COLUMN "reservationName" TEXT,
  ADD COLUMN "approvalStatus" "ReservationApprovalStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "paymentStatus" "ReservationPaymentStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "deliveryChannel" "DeliveryChannel" NOT NULL DEFAULT 'EMAIL',
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "rejectedReason" TEXT,
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "paymentConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "deliveryStatus" TEXT DEFAULT 'PENDING',
  ADD COLUMN "lastDeliveryAt" TIMESTAMP(3),
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;

-- Backfill from existing public reservation metadata
UPDATE "Ticket"
SET
  "reservationCode" = NULLIF("metadata"->>'reservationCode', ''),
  "reservationEmail" = NULLIF(LOWER(TRIM(COALESCE("metadata"->>'email', ''))), ''),
  "reservationName" = NULLIF(TRIM(COALESCE("metadata"->>'name', '')), ''),
  "reservationPhone" = NULLIF(regexp_replace(COALESCE("metadata"->>'phone', ''), '[^0-9]+', '', 'g'), ''),
  "approvalStatus" = CASE
    WHEN COALESCE("metadata"->>'channel', '') = 'public' AND COALESCE("metadata"->>'approval', '') = 'PENDING' THEN 'PENDING'::"ReservationApprovalStatus"
    WHEN COALESCE("metadata"->>'channel', '') = 'public' AND COALESCE("metadata"->>'approval', '') = 'REJECTED' THEN 'REJECTED'::"ReservationApprovalStatus"
    WHEN COALESCE("metadata"->>'channel', '') = 'public' AND COALESCE("metadata"->>'approval', '') = 'APPROVED' THEN 'APPROVED'::"ReservationApprovalStatus"
    WHEN COALESCE("metadata"->>'channel', '') = 'public' AND COALESCE("price", 0) > 0 THEN 'PENDING'::"ReservationApprovalStatus"
    WHEN COALESCE("metadata"->>'channel', '') = 'public' THEN 'APPROVED'::"ReservationApprovalStatus"
    ELSE 'NONE'::"ReservationApprovalStatus"
  END,
  "paymentStatus" = CASE
    WHEN COALESCE("metadata"->>'channel', '') = 'public' AND COALESCE("price", 0) > 0 AND COALESCE("metadata"->>'approval', '') = 'APPROVED' THEN 'CONFIRMED'::"ReservationPaymentStatus"
    WHEN COALESCE("metadata"->>'channel', '') = 'public' AND COALESCE("price", 0) > 0 THEN 'PENDING'::"ReservationPaymentStatus"
    ELSE 'NOT_REQUIRED'::"ReservationPaymentStatus"
  END,
  "deliveryStatus" = CASE
    WHEN COALESCE("metadata"->>'channel', '') = 'public' AND COALESCE("metadata"->>'approval', '') = 'APPROVED' THEN 'SENT'
    WHEN COALESCE("metadata"->>'channel', '') = 'public' AND COALESCE("price", 0) = 0 THEN 'SENT'
    ELSE COALESCE("deliveryStatus", 'PENDING')
  END;

CREATE UNIQUE INDEX "Ticket_reservationCode_key" ON "Ticket"("reservationCode");
CREATE INDEX "Ticket_eventId_approvalStatus_idx" ON "Ticket"("eventId", "approvalStatus");
CREATE INDEX "Ticket_eventId_paymentStatus_idx" ON "Ticket"("eventId", "paymentStatus");
CREATE INDEX "Ticket_eventId_reservationEmail_idx" ON "Ticket"("eventId", "reservationEmail");

-- Prevent duplicate active public reservations for same event + normalized email
CREATE UNIQUE INDEX "Ticket_active_public_reservation_email_key"
ON "Ticket"("eventId", "reservationEmail")
WHERE "reservationEmail" IS NOT NULL
  AND "approvalStatus" IN ('PENDING', 'APPROVED')
  AND "status" IN ('ISSUED', 'ACTIVE', 'CONSUMED');

ALTER TABLE "Ticket"
  ADD CONSTRAINT "Ticket_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
