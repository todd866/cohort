-- Make FeedEvent.sessionFingerprint nullable so authenticated users can
-- record events directly via userId without forcing an AnonymousSession row.
ALTER TABLE "FeedEvent" ALTER COLUMN "sessionFingerprint" DROP NOT NULL;
