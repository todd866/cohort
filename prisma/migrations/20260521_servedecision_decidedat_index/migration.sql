-- Index supporting the nightly ServeDecision retention prune, which deletes
-- rows older than the retention window (DELETE ... WHERE "decidedAt" < cutoff).
-- The existing composite indexes lead with userId, so a global range scan on
-- decidedAt couldn't use them. Created small (table is low-thousands of rows)
-- to avoid a costly index build later once retention is overdue.
CREATE INDEX IF NOT EXISTS "ServeDecision_decidedAt_idx"
  ON "ServeDecision" ("decidedAt");
