-- Add cloze variant grouping fields to Card.
--
-- Multi-blank MDX entries are split into N single-blank sibling cards at seed
-- time; siblings share variantGroupId so the scheduler can suppress same-group
-- cards within a session and the audit can collapse them when surfacing
-- diversity metrics.
--
-- See docs/superpowers/specs/2026-05-08-cloze-variants-design.md and
-- docs/superpowers/plans/2026-05-08-cloze-variants.md for the full design.
--
-- Domain:
--   variantGroupId — UUID-style string shared by sibling single-blank cards
--   variantIndex   — 0-based ordinal within the group
--   variantType    — 'cloze-blank' | 'legacy-anchor'

ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "variantGroupId" TEXT;
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "variantIndex" INTEGER;
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "variantType" TEXT;

CREATE INDEX IF NOT EXISTS "Card_variantGroupId_idx" ON "Card" ("variantGroupId");
CREATE INDEX IF NOT EXISTS "Card_variantGroupId_variantIndex_idx" ON "Card" ("variantGroupId", "variantIndex");
