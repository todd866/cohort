-- Add ServeDecision table — per-item "why this item?" trace.
--
-- Each live pathway (manifold, starter, rereview, instant, focused) writes
-- a ServeDecision row when an item is returned. Background cache builds
-- write rows with deliveryPath = NULL; cache delivery either UPDATEs the
-- matching row in-session or INSERTs a child row cross-session via
-- parentDecisionId.
--
-- See docs/superpowers/specs/2026-05-08-serve-decision-trace-design.md and
-- docs/superpowers/plans/2026-05-08-serve-decision-trace.md for the full design.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ServeDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "batchId" TEXT,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "rotation" TEXT,
    "week" INTEGER,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exposedAt" TIMESTAMPTZ(3),
    "answeredAt" TIMESTAMPTZ(3),
    "decisionPath" TEXT,
    "deliveryPath" TEXT,
    "queueReason" TEXT,
    "position" INTEGER,
    "rankInPool" INTEGER,
    "poolSize" INTEGER,
    "priority" DOUBLE PRECISION,
    "predictedRecall" DOUBLE PRECISION,
    "difficultyTier" TEXT,
    "conceptId" TEXT,
    "clusterId" TEXT,
    "variantGroupId" TEXT,
    "variantIndex" INTEGER,
    "variantType" TEXT,
    "isCorrect" BOOLEAN,
    "quality" INTEGER,
    "responseTimeMs" INTEGER,
    "parentDecisionId" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB,

    CONSTRAINT "ServeDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServeDecision_userId_itemType_itemId_decidedAt_idx" ON "ServeDecision"("userId", "itemType", "itemId", "decidedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServeDecision_userId_sessionId_position_idx" ON "ServeDecision"("userId", "sessionId", "position");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServeDecision_sessionId_idx" ON "ServeDecision"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServeDecision_parentDecisionId_idx" ON "ServeDecision"("parentDecisionId");

-- ============================================================
-- Foreign keys
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServeDecision_userId_fkey'
  ) THEN
    ALTER TABLE "ServeDecision"
      ADD CONSTRAINT "ServeDecision_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
