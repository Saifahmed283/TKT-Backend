-- AlterTable
ALTER TABLE "Credential" ADD COLUMN "shortCode" TEXT;

-- Backfill existing credentials with unique short codes
DO $$
DECLARE r RECORD;
DECLARE candidate TEXT;
DECLARE chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
DECLARE i INT;
BEGIN
  FOR r IN SELECT id FROM "Credential" WHERE "shortCode" IS NULL LOOP
    LOOP
      candidate := 'TKT-';
      FOR i IN 1..5 LOOP
        candidate := candidate || substr(chars, floor(random() * length(chars) + 1)::int, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Credential" WHERE "shortCode" = candidate);
    END LOOP;
    UPDATE "Credential" SET "shortCode" = candidate WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "Credential_shortCode_key" ON "Credential"("shortCode");