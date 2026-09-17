-- Keep this migration outside an explicit transaction: PostgreSQL requires
-- CREATE INDEX CONCURRENTLY to run as a top-level statement.
--
-- Two scheduler reads want only the ServeDecision rows a learner actually
-- SAW — the card-signal attribution (unified-scheduler, servedRows) and
-- question familiarity (bulk-candidates, loadQuestionFamiliarity). About
-- six rows in seven on this table are cache-build decisions with no
-- deliveryPath, and they share the (userId, itemType, itemId) prefix with
-- the rows that matter, so the existing composite index finds the key and
-- then fetches every one of them from a multi-gigabyte heap to throw most
-- away. Measured on production 2026-09-17 for a long-history account: the
-- attribution read ran 31 s cold (46,101 heap rows for 342 kept) and the
-- familiarity read chose a parallel seq scan of the whole table at 12 s.
-- Both sat inside the live session build, so a topic-scoped review — which
-- has no warmed cache to fall back on — showed "Taking longer than usual"
-- and then timed out the Prisma pool for everyone sharing the function.
--
-- A partial index holding only exposed rows, covering the columns those two
-- reads select, makes the first an index scan and the second index-only.
-- Planner costs with the index hypothesised: 104,008 → 4,843 and
-- 329,635 → 2,573. Prisma cannot express a partial or INCLUDE index, so
-- this exists only in SQL; the drift check tolerates it (verified against
-- a disposable database before commit).
CREATE INDEX CONCURRENTLY "ServeDecision_exposed_userId_itemType_itemId_decidedAt_idx"
    ON "ServeDecision" ("userId", "itemType", "itemId", "decidedAt" DESC)
    INCLUDE ("conceptId", "exposedAt")
    WHERE "deliveryPath" IS NOT NULL OR "exposedAt" IS NOT NULL;
