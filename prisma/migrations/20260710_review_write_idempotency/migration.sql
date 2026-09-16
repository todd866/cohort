-- Make review idempotency receipts transactional with their domain writes and
-- make per-question attempt numbers a database-enforced sequence.

-- Historical production `db push` created this table, but the committed fresh
-- migration chain did not. Create the final shape here so this migration works
-- both on production and before the guarded fresh-schema catch-up migration.
CREATE TABLE IF NOT EXISTS "SyncOperation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientOperationId" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "requestFingerprint" TEXT,
  "result" JSONB,
  "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SyncOperation"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS "requestFingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "result" JSONB,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Keep the database default during the expand/deploy window. The currently
-- deployed Prisma client predates this column and therefore omits it when it
-- records a mobile sync receipt; dropping the default before the compatible
-- application deploy would temporarily disable that dedupe path.

CREATE INDEX IF NOT EXISTS "SyncOperation_status_updatedAt_idx"
  ON "SyncOperation" ("status", "updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'SyncOperation_status_check'
      AND conrelid = '"SyncOperation"'::regclass
  ) THEN
    ALTER TABLE "SyncOperation"
      ADD CONSTRAINT "SyncOperation_status_check"
      CHECK ("status" IN ('pending', 'completed'));
  END IF;
END
$$;

-- ROW_NUMBER() ranks only this statement's snapshot, and Postgres has no gap
-- locks, so between the renumber and CREATE UNIQUE INDEX a still-deployed
-- count-then-create writer can insert a second row at attempt N+1 and abort the
-- migration. Hold the table against writers for both statements. Readers are
-- unaffected, and QuestionResponse is small (~12k rows), so this is brief.
LOCK TABLE "QuestionResponse" IN SHARE ROW EXCLUSIVE MODE;

-- Historical count-then-create writers could assign duplicate or gapped
-- numbers. Rebuild a deterministic 1..N sequence before adding the authority
-- constraint. The update is idempotent and preserves chronological order.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "userId", "questionId"
      ORDER BY "createdAt" ASC, id ASC
    )::INTEGER AS canonical_attempt
  FROM "QuestionResponse"
)
UPDATE "QuestionResponse" AS response
SET "attemptNumber" = ranked.canonical_attempt
FROM ranked
WHERE response.id = ranked.id
  AND response."attemptNumber" IS DISTINCT FROM ranked.canonical_attempt;

CREATE UNIQUE INDEX IF NOT EXISTS "QuestionResponse_userId_questionId_attemptNumber_key"
  ON "QuestionResponse" ("userId", "questionId", "attemptNumber");
