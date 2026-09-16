-- Privacy-safe pre-compute denominator for target-capable scheduler attempts.
-- This migration is additive: no historical decision is backfilled and no
-- existing serving path is activated by the schema foundation alone.

CREATE TABLE "ExamTargetDecisionAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "rotation" TEXT NOT NULL,
    "decisionPath" TEXT NOT NULL,
    "targetSnapshotId" TEXT NOT NULL,
    "activationRevision" INTEGER NOT NULL,
    "schedulerVersion" VARCHAR(200) NOT NULL,
    "policyDigest" VARCHAR(64) NOT NULL,
    "mode" TEXT NOT NULL,
    "assignment" TEXT NOT NULL,
    "requestedSize" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'started',
    "failureClass" TEXT,
    "servedDisposition" TEXT,
    "servedItemCount" INTEGER,
    "fallbackTracePersisted" BOOLEAN,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExamTargetDecisionAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExamTargetDecisionAttempt_rotation_check" CHECK (
        "rotation" IN ('critical-care', 'paam', 'cah', 'pwh')
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_decision_path_check" CHECK (
        "decisionPath" IN ('manifold-walk', 'review-filter')
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_mode_check" CHECK (
        "mode" IN ('shadow', 'active')
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_assignment_check" CHECK (
        "assignment" IN ('control', 'treatment')
        AND ("mode" <> 'shadow' OR "assignment" = 'control')
        AND ("assignment" <> 'treatment' OR "mode" = 'active')
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_identity_check" CHECK (
        length("id") BETWEEN 1 AND 200
        AND "id" ~ '^[A-Za-z0-9]+([._:-][A-Za-z0-9]+)*$'
        AND length("userId") BETWEEN 1 AND 200
        AND "userId" ~ '^[A-Za-z0-9]+([._:-][A-Za-z0-9]+)*$'
        AND length("targetSnapshotId") BETWEEN 1 AND 200
        AND "targetSnapshotId" ~ '^[A-Za-z0-9]+([._:-][A-Za-z0-9]+)*$'
        AND length("schedulerVersion") BETWEEN 1 AND 200
        AND "schedulerVersion" ~ '^[a-z0-9]+([._:-][a-z0-9]+)*$'
        AND "policyDigest" ~ '^[a-f0-9]{64}$'
        AND "activationRevision" > 0
        AND "requestedSize" BETWEEN 1 AND 100
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_outcome_check" CHECK (
        "outcome" IN (
            'started',
            'decision_persisted',
            'control_fallback',
            'no_items',
            'request_failed'
        )
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_failure_class_check" CHECK (
        "failureClass" IS NULL OR "failureClass" IN (
            'precompute_failed',
            'scheduler_compute_failed',
            'postprocess_failed',
            'decision_build_failed',
            'telemetry_validation_failed',
            'persistence_transaction_failed',
            'unclassified_runtime_failed'
        )
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_retention_check" CHECK (
        "expiresAt" > "startedAt"
        AND "expiresAt" <= "startedAt" + INTERVAL '30 days'
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_completion_time_check" CHECK (
        "completedAt" IS NULL OR (
            "completedAt" >= "startedAt"
            AND "completedAt" <= "expiresAt"
        )
    ),
    CONSTRAINT "ExamTargetDecisionAttempt_terminal_shape_check" CHECK (
        (
            "outcome" = 'started'
            AND "failureClass" IS NULL
            AND "servedDisposition" IS NULL
            AND "servedItemCount" IS NULL
            AND "fallbackTracePersisted" IS NULL
            AND "completedAt" IS NULL
        ) OR (
            "outcome" = 'decision_persisted'
            AND "failureClass" IS NULL
            AND "servedDisposition" IS NOT NULL
            AND "servedDisposition" = "assignment"
            AND "servedItemCount" IS NOT NULL
            AND "servedItemCount" BETWEEN 1 AND "requestedSize"
            AND "fallbackTracePersisted" IS NULL
            AND "completedAt" IS NOT NULL
        ) OR (
            "outcome" = 'control_fallback'
            AND "failureClass" IS NOT NULL
            AND "servedDisposition" IS NOT NULL
            AND "servedDisposition" = 'control'
            AND "servedItemCount" IS NOT NULL
            AND "servedItemCount" BETWEEN 1 AND "requestedSize"
            AND "fallbackTracePersisted" IS NOT NULL
            AND "completedAt" IS NOT NULL
        ) OR (
            -- no_items describes the final empty response. failureClass may
            -- retain a typed upstream fault so denominator audits do not lose
            -- a compute failure merely because control also had no items.
            "outcome" = 'no_items'
            AND "servedDisposition" IS NOT NULL
            AND "servedDisposition" = 'none'
            AND "servedItemCount" IS NOT NULL
            AND "servedItemCount" = 0
            AND "fallbackTracePersisted" IS NULL
            AND "completedAt" IS NOT NULL
        ) OR (
            "outcome" = 'request_failed'
            AND "failureClass" IS NOT NULL
            AND "servedDisposition" IS NOT NULL
            AND "servedDisposition" = 'none'
            AND "servedItemCount" IS NOT NULL
            AND "servedItemCount" = 0
            AND "fallbackTracePersisted" IS NULL
            AND "completedAt" IS NOT NULL
        )
    )
);

-- Inserts are admission records only. The sole update is the first transition
-- from started to a constrained terminal state; terminal rows and identity /
-- retention metadata are immutable. Deletes remain available for user erasure
-- and bounded expiry pruning.
CREATE FUNCTION "guard_exam_target_attempt_lifecycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."outcome" <> 'started' THEN
            RAISE EXCEPTION 'exam target attempts must be admitted as started'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD."outcome" <> 'started' THEN
            RAISE EXCEPTION 'terminal exam target attempts are immutable'
                USING ERRCODE = '55000';
        END IF;
        IF NEW."outcome" = 'started' THEN
            RAISE EXCEPTION 'exam target attempt updates must terminalize the row'
                USING ERRCODE = '55000';
        END IF;
        IF ROW(
            NEW."id",
            NEW."userId",
            NEW."sessionId",
            NEW."batchId",
            NEW."rotation",
            NEW."decisionPath",
            NEW."targetSnapshotId",
            NEW."activationRevision",
            NEW."schedulerVersion",
            NEW."policyDigest",
            NEW."mode",
            NEW."assignment",
            NEW."requestedSize",
            NEW."startedAt",
            NEW."expiresAt"
        ) IS DISTINCT FROM ROW(
            OLD."id",
            OLD."userId",
            OLD."sessionId",
            OLD."batchId",
            OLD."rotation",
            OLD."decisionPath",
            OLD."targetSnapshotId",
            OLD."activationRevision",
            OLD."schedulerVersion",
            OLD."policyDigest",
            OLD."mode",
            OLD."assignment",
            OLD."requestedSize",
            OLD."startedAt",
            OLD."expiresAt"
        ) THEN
            RAISE EXCEPTION 'exam target attempt identity and retention are immutable'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    RETURN OLD;
END;
$$;

CREATE TRIGGER "ExamTargetDecisionAttempt_lifecycle"
BEFORE INSERT OR UPDATE OR DELETE ON "ExamTargetDecisionAttempt"
FOR EACH ROW EXECUTE FUNCTION "guard_exam_target_attempt_lifecycle"();

ALTER TABLE "SchedulerDecisionSet" ADD COLUMN "attemptId" TEXT;

CREATE UNIQUE INDEX "ExamTargetDecisionAttempt_admission_key"
    ON "ExamTargetDecisionAttempt"("userId", "sessionId", "batchId", "targetSnapshotId", "decisionPath");
CREATE INDEX "ExamTargetDecisionAttempt_targetSnapshotId_startedAt_idx"
    ON "ExamTargetDecisionAttempt"("targetSnapshotId", "startedAt");
CREATE INDEX "ExamTargetDecisionAttempt_userId_startedAt_idx"
    ON "ExamTargetDecisionAttempt"("userId", "startedAt");
CREATE INDEX "ExamTargetDecisionAttempt_rotation_mode_startedAt_idx"
    ON "ExamTargetDecisionAttempt"("rotation", "mode", "startedAt");
CREATE INDEX "ExamTargetDecisionAttempt_expiresAt_idx"
    ON "ExamTargetDecisionAttempt"("expiresAt");
CREATE UNIQUE INDEX "SchedulerDecisionSet_attemptId_key"
    ON "SchedulerDecisionSet"("attemptId");

ALTER TABLE "ExamTargetDecisionAttempt"
    ADD CONSTRAINT "ExamTargetDecisionAttempt_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExamTargetDecisionAttempt"
    ADD CONSTRAINT "ExamTargetDecisionAttempt_target_snapshot_rotation_fkey"
    FOREIGN KEY ("targetSnapshotId", "rotation") REFERENCES "ExamTargetSnapshot"("id", "rotation")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SchedulerDecisionSet"
    ADD CONSTRAINT "SchedulerDecisionSet_attemptId_fkey"
    FOREIGN KEY ("attemptId") REFERENCES "ExamTargetDecisionAttempt"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
