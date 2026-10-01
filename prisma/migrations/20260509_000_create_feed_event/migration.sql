-- FeedEvent was originally introduced with `prisma db push`, so the following
-- nullable-fingerprint migration had no reproducible prerequisite on a fresh
-- database. Create the pre-2026-05-09 shape idempotently; production already
-- has this table and therefore treats this migration as a no-op.
CREATE TABLE IF NOT EXISTS "FeedEvent" (
    "id" TEXT NOT NULL,
    "sessionFingerprint" TEXT NOT NULL,
    "userId" TEXT,
    "eventType" TEXT NOT NULL,
    "itemId" TEXT,
    "itemType" TEXT,
    "feedPosition" INTEGER,
    "action" TEXT,
    "result" TEXT,
    "dwellMs" INTEGER,
    "metadata" JSONB,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FeedEvent_sessionFingerprint_timestamp_idx"
ON "FeedEvent"("sessionFingerprint", "timestamp");
CREATE INDEX IF NOT EXISTS "FeedEvent_itemId_eventType_idx"
ON "FeedEvent"("itemId", "eventType");
CREATE INDEX IF NOT EXISTS "FeedEvent_userId_timestamp_idx"
ON "FeedEvent"("userId", "timestamp");
CREATE INDEX IF NOT EXISTS "FeedEvent_eventType_timestamp_idx"
ON "FeedEvent"("eventType", "timestamp");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FeedEvent_sessionFingerprint_fkey'
  ) THEN
    ALTER TABLE "FeedEvent"
      ADD CONSTRAINT "FeedEvent_sessionFingerprint_fkey"
      FOREIGN KEY ("sessionFingerprint") REFERENCES "AnonymousSession"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END$$;
