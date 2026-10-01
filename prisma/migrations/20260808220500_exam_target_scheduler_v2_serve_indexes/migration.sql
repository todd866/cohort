-- Keep this migration outside an explicit transaction: PostgreSQL requires
-- CREATE INDEX CONCURRENTLY to run as a top-level statement.

CREATE INDEX CONCURRENTLY "ServeDecision_decisionSetId_idx"
    ON "ServeDecision"("decisionSetId");

CREATE INDEX CONCURRENTLY "ServeDecision_examTargetSnapshotId_decidedAt_idx"
    ON "ServeDecision"("examTargetSnapshotId", "decidedAt");

CREATE INDEX CONCURRENTLY "ServeDecision_targetRotation_targetDomainCode_decidedAt_idx"
    ON "ServeDecision"("targetRotation", "targetDomainCode", "decidedAt");
