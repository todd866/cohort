-- Persist per-item exam-targeting scores computed from private calibration
-- sources. The scalar column supports curation/sorting; the JSONB metadata
-- preserves source breakdown and top domains for auditability.

ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "examRelevance" DOUBLE PRECISION;
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "examRelevanceMeta" JSONB;
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "examRelevanceUpdatedAt" TIMESTAMPTZ(3);

CREATE INDEX IF NOT EXISTS "Card_examRelevance_idx" ON "Card" ("examRelevance");
CREATE INDEX IF NOT EXISTS "Card_examRelevanceUpdatedAt_idx" ON "Card" ("examRelevanceUpdatedAt");

ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "examRelevance" DOUBLE PRECISION;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "examRelevanceMeta" JSONB;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "examRelevanceUpdatedAt" TIMESTAMPTZ(3);

CREATE INDEX IF NOT EXISTS "Question_examRelevance_idx" ON "Question" ("examRelevance");
CREATE INDEX IF NOT EXISTS "Question_examRelevanceUpdatedAt_idx" ON "Question" ("examRelevanceUpdatedAt");
