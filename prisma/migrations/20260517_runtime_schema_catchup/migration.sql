-- Catch up runtime schema changes that were introduced by manual schema pushes.
--
-- This migration is intentionally idempotent: production may already have these
-- columns/tables from `prisma db push`, while fresh/local environments need a
-- reproducible migration path from the committed migration history.

-- Card lifecycle, image-caption, feed, and empirical difficulty fields.
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "imageCaption" TEXT;
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "feedScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ(3);
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "shelvedAt" TIMESTAMPTZ(3);
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "facilityIndex" DOUBLE PRECISION;
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "avgResponseTimeMs" INTEGER;
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "sampleSize" INTEGER;

CREATE INDEX IF NOT EXISTS "Card_deletedAt_idx" ON "Card" ("deletedAt");
CREATE INDEX IF NOT EXISTS "Card_feedScore_idx" ON "Card" ("feedScore");

-- Question image-caption, feed, exclusion, and display-order analytics.
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "imageCaption" TEXT;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "feedScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "excluded" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Question_feedScore_idx" ON "Question" ("feedScore");

ALTER TABLE "QuestionResponse" ADD COLUMN IF NOT EXISTS "correctDisplayPosition" INTEGER;
ALTER TABLE "QuestionResponse" ADD COLUMN IF NOT EXISTS "selectedDisplayPosition" INTEGER;

-- Direct MCQ citation graph.
CREATE TABLE IF NOT EXISTS "QuestionCitation" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "relationship" TEXT NOT NULL DEFAULT 'supports',
    "jurisdictionNote" TEXT,
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "QuestionCitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "QuestionCitation_questionId_citationId_key" ON "QuestionCitation" ("questionId", "citationId");
CREATE INDEX IF NOT EXISTS "QuestionCitation_citationId_idx" ON "QuestionCitation" ("citationId");
CREATE INDEX IF NOT EXISTS "QuestionCitation_addedBy_idx" ON "QuestionCitation" ("addedBy");
CREATE INDEX IF NOT EXISTS "QuestionCitation_isPrimary_idx" ON "QuestionCitation" ("isPrimary");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'QuestionCitation_questionId_fkey'
  ) THEN
    ALTER TABLE "QuestionCitation"
      ADD CONSTRAINT "QuestionCitation_questionId_fkey"
      FOREIGN KEY ("questionId") REFERENCES "Question"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'QuestionCitation_citationId_fkey'
  ) THEN
    ALTER TABLE "QuestionCitation"
      ADD CONSTRAINT "QuestionCitation_citationId_fkey"
      FOREIGN KEY ("citationId") REFERENCES "SourceCitation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- Actual block exam outcomes for learning analytics.
CREATE TABLE IF NOT EXISTS "ExamResult" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "block" INTEGER NOT NULL,
    "examDate" DATE NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExamResult_userId_rotation_block_key" ON "ExamResult" ("userId", "rotation", "block");
CREATE INDEX IF NOT EXISTS "ExamResult_rotation_block_idx" ON "ExamResult" ("rotation", "block");
CREATE INDEX IF NOT EXISTS "ExamResult_userId_idx" ON "ExamResult" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExamResult_userId_fkey'
  ) THEN
    ALTER TABLE "ExamResult"
      ADD CONSTRAINT "ExamResult_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
