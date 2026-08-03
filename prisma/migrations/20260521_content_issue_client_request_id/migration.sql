-- Idempotency key for content flags. The client outbox may replay a flag whose
-- HTTP response was lost; dedupe on this id so replays return the existing issue
-- instead of creating a duplicate. Existing rows have NULL here; Postgres treats
-- NULLs as distinct under a UNIQUE index, so legacy rows never collide.
ALTER TABLE "ContentIssue" ADD COLUMN IF NOT EXISTS "clientRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ContentIssue_clientRequestId_key"
  ON "ContentIssue" ("clientRequestId");
