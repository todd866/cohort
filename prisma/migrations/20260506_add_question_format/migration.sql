-- Add cognitive-format axis to Question.
--
-- Used by the scheduler to prefer un-seen formats within a recently-served
-- concept (variety in *how* a concept is probed, not just *which* concept).
-- Backfilled by scripts/audit/backfill-question-format.ts using
-- src/lib/questions/format-tagger.ts.
--
-- Domain: 'cloze' | 'recall' | 'mechanism' | 'interpretation' | 'trap' | 'comparison' | 'scenario' | 'unknown'

ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "format" TEXT;
CREATE INDEX IF NOT EXISTS "Question_format_idx" ON "Question" ("format");
