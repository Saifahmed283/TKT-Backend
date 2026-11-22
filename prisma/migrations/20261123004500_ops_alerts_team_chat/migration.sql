-- Phase E extras: ops alerts and team chat

CREATE TABLE IF NOT EXISTS "OpsAlert" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'help',
  "message" TEXT NOT NULL,
  "teamId" TEXT,
  "createdById" TEXT,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TeamChatMessage" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "teamId" TEXT,
  "userId" TEXT,
  "text" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OpsAlert_eventId_createdAt_idx" ON "OpsAlert"("eventId","createdAt");
CREATE INDEX IF NOT EXISTS "OpsAlert_teamId_idx" ON "OpsAlert"("teamId");
CREATE INDEX IF NOT EXISTS "TeamChatMessage_eventId_createdAt_idx" ON "TeamChatMessage"("eventId","createdAt");
CREATE INDEX IF NOT EXISTS "TeamChatMessage_teamId_createdAt_idx" ON "TeamChatMessage"("teamId","createdAt");

DO $$ BEGIN ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "TeamChatMessage" ADD CONSTRAINT "TeamChatMessage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
