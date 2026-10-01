-- Grounded-audit provenance on the citation link tables.
--
-- The grounded lane already recorded WHICH passage supported a claim, what the
-- judge decided, when, with which model, against which corpus, and whether the
-- source itself had cleared a PaperLibrary trust scan. All of that lived only in
-- content/grounded-citations.json and was dropped at db:seed, so the card detail
-- page could name a source but never show what was actually verified.
--
-- Every column is nullable: citation links created by authoring, curation, or a
-- user carry no judgement and must stay valid without one.

ALTER TABLE "CardCitation"
  ADD COLUMN "groundingState" TEXT,
  ADD COLUMN "judgedAt"       TIMESTAMPTZ(3),
  ADD COLUMN "judgedBy"       TEXT,
  ADD COLUMN "corpusVersion"  TEXT,
  ADD COLUMN "sourceTrust"    TEXT,
  ADD COLUMN "matchCoverage"  DOUBLE PRECISION;

ALTER TABLE "QuestionCitation"
  ADD COLUMN "groundingState" TEXT,
  ADD COLUMN "judgedAt"       TIMESTAMPTZ(3),
  ADD COLUMN "judgedBy"       TEXT,
  ADD COLUMN "corpusVersion"  TEXT,
  ADD COLUMN "sourceTrust"    TEXT,
  ADD COLUMN "matchCoverage"  DOUBLE PRECISION;

-- The card page filters weak/contradicting links out of the "supports" lane.
CREATE INDEX "CardCitation_groundingState_idx" ON "CardCitation"("groundingState");
CREATE INDEX "QuestionCitation_groundingState_idx" ON "QuestionCitation"("groundingState");
