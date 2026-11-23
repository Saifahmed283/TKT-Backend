-- Add organization folders and event folder assignment (additive)
CREATE TABLE "OrganizationFolder" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationFolder_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "folderId" TEXT;

CREATE INDEX "OrganizationFolder_orgId_idx" ON "OrganizationFolder"("orgId");
CREATE UNIQUE INDEX "OrganizationFolder_orgId_name_key" ON "OrganizationFolder"("orgId", "name");
CREATE INDEX "Event_folderId_idx" ON "Event"("folderId");

ALTER TABLE "OrganizationFolder" ADD CONSTRAINT "OrganizationFolder_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Event" ADD CONSTRAINT "Event_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "OrganizationFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
