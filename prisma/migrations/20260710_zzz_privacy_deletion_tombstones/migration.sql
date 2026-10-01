-- Durable two-phase deletion for user documents and full account erasure.
-- This migration intentionally sorts after 20260710_zz_schema_catchup so a
-- fresh historical database has UserDocument before these ALTER statements.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "privacyDeletionRequestedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "privacyDeletionNotBefore" TIMESTAMPTZ(3);

ALTER TABLE "UserDocument"
  ADD COLUMN IF NOT EXISTS "uploadUrlExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "deletionRequestedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "deleteAfter" TIMESTAMPTZ(3);

-- Existing URLs were issued when the row was created and lived for ten
-- minutes. Backfilling all legacy rows is conservative and makes a deploy
-- during an active upload safe without pretending the URL never existed.
UPDATE "UserDocument"
SET "uploadUrlExpiresAt" = "createdAt" + INTERVAL '10 minutes'
WHERE "uploadUrlExpiresAt" IS NULL;

-- The old application omits this new field. Keep allocations made during the
-- migrate-to-application window bounded, and make an unbounded upload URL
-- record impossible after this migration commits.
ALTER TABLE "UserDocument"
  ALTER COLUMN "uploadUrlExpiresAt" SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '10 minutes'),
  ALTER COLUMN "uploadUrlExpiresAt" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "UserDocument_status_deleteAfter_idx"
  ON "UserDocument"("status", "deleteAfter");
