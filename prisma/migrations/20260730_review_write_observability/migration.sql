-- Link immutable card/MCQ learning events to their idempotency receipts and
-- retain coarse, privacy-bounded origin/timing diagnostics.

DO $$
BEGIN
  CREATE TYPE "ReviewDeviceBucket" AS ENUM ('mobile', 'tablet', 'desktop', 'unknown');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "ReviewWriteTransport" AS ENUM ('web_review', 'mobile_sync', 'server');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "ReviewTimestampSource" AS ENUM ('client_action', 'server_received');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "LearningEvent"
  ADD COLUMN IF NOT EXISTS "clientOperationId" TEXT,
  ADD COLUMN IF NOT EXISTS "deviceBucket" "ReviewDeviceBucket",
  ADD COLUMN IF NOT EXISTS "writeTransport" "ReviewWriteTransport",
  ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "timestampSource" "ReviewTimestampSource";

CREATE UNIQUE INDEX IF NOT EXISTS "LearningEvent_userId_clientOperationId_key"
  ON "LearningEvent" ("userId", "clientOperationId");

CREATE INDEX IF NOT EXISTS "LearningEvent_userId_deviceBucket_timestamp_idx"
  ON "LearningEvent" ("userId", "deviceBucket", "timestamp");
