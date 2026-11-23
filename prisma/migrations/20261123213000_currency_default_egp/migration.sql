-- Align currency defaults with TKT default (EGP). Existing rows keep their stored currency.
ALTER TABLE "TicketType" ALTER COLUMN "currency" SET DEFAULT 'EGP';
ALTER TABLE "Bus" ALTER COLUMN "currency" SET DEFAULT 'EGP';
