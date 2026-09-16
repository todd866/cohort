-- Exam Target Scheduler v2 foundation.
--
-- This migration is intentionally additive. It creates immutable target
-- artifacts and nullable ServeDecision trace columns without backfilling or
-- rewriting existing serve history. High-volume ServeDecision indexes are
-- created CONCURRENTLY by the following migration.

-- Snapshot compilation hashes pgvector's canonical halfvec binary form inside
-- Postgres so raw vectors never egress to the operator process.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "ExamTargetItemType" AS ENUM ('card', 'question');
CREATE TYPE "ExamTargetAssignmentMethod" AS ENUM ('curated', 'centroid');

CREATE TABLE "ExamTargetSnapshot" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'built',
    "targetBasis" TEXT NOT NULL,
    "validFrom" TIMESTAMPTZ(3),
    "supersedesId" TEXT,
    "weightPolicy" JSONB NOT NULL,
    "scorerVersion" TEXT NOT NULL,
    "embeddingModel" TEXT,
    "embeddingDimensions" INTEGER,
    "sourceManifestHash" TEXT NOT NULL,
    "anchorCorpusHash" TEXT,
    "artifactHash" TEXT NOT NULL,
    "itemRowsHash" TEXT NOT NULL,
    "conceptRowsHash" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "buildManifest" JSONB NOT NULL,
    "runtimeProjection" JSONB NOT NULL,
    "privacyValidated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT,
    "validatedAt" TIMESTAMPTZ(3),
    "reviewedBy" TEXT,
    "activatedAt" TIMESTAMPTZ(3),
    "activatedBy" TEXT,

    CONSTRAINT "ExamTargetSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExamTargetSnapshot_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "ExamTargetSnapshot_status_check" CHECK ("status" IN ('built', 'validated', 'active', 'retired')),
    CONSTRAINT "ExamTargetSnapshot_target_basis_check" CHECK ("targetBasis" IN ('official', 'hybrid', 'proxy')),
    CONSTRAINT "ExamTargetSnapshot_schema_version_check" CHECK (btrim("schemaVersion") <> ''),
    CONSTRAINT "ExamTargetSnapshot_embedding_dimensions_check" CHECK ("embeddingDimensions" IS NULL OR "embeddingDimensions" > 0),
    CONSTRAINT "ExamTargetSnapshot_supersedes_self_check" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id"),
    CONSTRAINT "ExamTargetSnapshot_provenance_check" CHECK (
        btrim("targetId") <> ''
        AND btrim("rotation") <> ''
        AND btrim("scorerVersion") <> ''
        AND btrim("sourceManifestHash") <> ''
        AND btrim("artifactHash") <> ''
        AND btrim("itemRowsHash") <> ''
        AND btrim("conceptRowsHash") <> ''
        AND btrim("manifestHash") <> ''
    )
);

-- Snapshot identity, reviewed definition, build provenance, and row-set hashes
-- are frozen at insert. Lifecycle and audit receipt fields intentionally remain
-- mutable so a successfully audited snapshot can advance through
-- built -> validated -> active -> retired without rewriting its evidence.
CREATE FUNCTION "guard_exam_target_snapshot_immutability"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(
        NEW."id",
        NEW."targetId",
        NEW."revision",
        NEW."schemaVersion",
        NEW."rotation",
        NEW."targetBasis",
        NEW."validFrom",
        NEW."supersedesId",
        NEW."weightPolicy",
        NEW."scorerVersion",
        NEW."embeddingModel",
        NEW."embeddingDimensions",
        NEW."sourceManifestHash",
        NEW."anchorCorpusHash",
        NEW."artifactHash",
        NEW."itemRowsHash",
        NEW."conceptRowsHash",
        NEW."manifestHash",
        NEW."buildManifest",
        NEW."runtimeProjection",
        NEW."createdAt",
        NEW."generatedBy"
    ) IS DISTINCT FROM ROW(
        OLD."id",
        OLD."targetId",
        OLD."revision",
        OLD."schemaVersion",
        OLD."rotation",
        OLD."targetBasis",
        OLD."validFrom",
        OLD."supersedesId",
        OLD."weightPolicy",
        OLD."scorerVersion",
        OLD."embeddingModel",
        OLD."embeddingDimensions",
        OLD."sourceManifestHash",
        OLD."anchorCorpusHash",
        OLD."artifactHash",
        OLD."itemRowsHash",
        OLD."conceptRowsHash",
        OLD."manifestHash",
        OLD."buildManifest",
        OLD."runtimeProjection",
        OLD."createdAt",
        OLD."generatedBy"
    ) THEN
        RAISE EXCEPTION 'exam target snapshot definition and provenance are immutable; create a new snapshot revision'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ExamTargetSnapshot_immutable_definition"
BEFORE UPDATE ON "ExamTargetSnapshot"
FOR EACH ROW EXECUTE FUNCTION "guard_exam_target_snapshot_immutability"();

CREATE TABLE "ItemExamTargetScore" (
    "id" TEXT NOT NULL,
    "targetSnapshotId" TEXT NOT NULL,
    "itemType" "ExamTargetItemType" NOT NULL,
    "itemId" TEXT NOT NULL,
    "sourceRotation" TEXT NOT NULL,
    "embeddingHash" TEXT NOT NULL,
    "domainCode" TEXT NOT NULL,
    "assignmentMethod" "ExamTargetAssignmentMethod" NOT NULL,
    "rawSimilarity" DOUBLE PRECISION,
    "zSimilarity" DOUBLE PRECISION,
    "runnerUpDomainCode" TEXT,
    "assignmentMargin" DOUBLE PRECISION,
    "assignmentConfidence" DOUBLE PRECISION NOT NULL,
    "geometryConfidence" DOUBLE PRECISION NOT NULL,
    "fitPercentile" DOUBLE PRECISION,
    "effectiveDomainWeight" DOUBLE PRECISION NOT NULL,
    "weightProvenance" TEXT NOT NULL,
    "domainPriorityIndex" DOUBLE PRECISION NOT NULL,
    "itemTargetIndex" DOUBLE PRECISION NOT NULL,
    "scoredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemExamTargetScore_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ItemExamTargetScore_assignment_audit_scalars_check" CHECK (
        ("rawSimilarity" IS NULL OR "rawSimilarity"::text NOT IN ('NaN', 'Infinity', '-Infinity'))
        AND ("zSimilarity" IS NULL OR "zSimilarity"::text NOT IN ('NaN', 'Infinity', '-Infinity'))
        AND (
            "assignmentMargin" IS NULL
            OR (
                "assignmentMargin"::text NOT IN ('NaN', 'Infinity', '-Infinity')
                AND "assignmentMargin" >= 0
            )
        )
    ),
    CONSTRAINT "ItemExamTargetScore_assignment_confidence_check" CHECK ("assignmentConfidence" >= 0 AND "assignmentConfidence" <= 1),
    CONSTRAINT "ItemExamTargetScore_geometry_confidence_check" CHECK ("geometryConfidence" >= 0 AND "geometryConfidence" <= 1),
    CONSTRAINT "ItemExamTargetScore_fit_percentile_check" CHECK ("fitPercentile" IS NULL OR ("fitPercentile" >= 0 AND "fitPercentile" <= 1)),
    CONSTRAINT "ItemExamTargetScore_domain_weight_check" CHECK ("effectiveDomainWeight" >= 0 AND "effectiveDomainWeight" <= 1),
    CONSTRAINT "ItemExamTargetScore_domain_priority_check" CHECK ("domainPriorityIndex" >= 0 AND "domainPriorityIndex" <= 1),
    CONSTRAINT "ItemExamTargetScore_target_index_check" CHECK ("itemTargetIndex" >= 0 AND "itemTargetIndex" <= 1),
    CONSTRAINT "ItemExamTargetScore_identity_check" CHECK (
        btrim("itemId") <> ''
        AND btrim("sourceRotation") <> ''
        AND "embeddingHash" ~ '^[a-f0-9]{64}$'
        AND btrim("domainCode") <> ''
        AND btrim("weightProvenance") <> ''
        AND (
            "runnerUpDomainCode" IS NULL
            OR (
                btrim("runnerUpDomainCode") <> ''
                AND "runnerUpDomainCode" <> "domainCode"
            )
        )
    )
);

CREATE TABLE "ConceptExamTargetScore" (
    "id" TEXT NOT NULL,
    "targetSnapshotId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "primaryDomainCode" TEXT NOT NULL,
    "domainMix" JSONB NOT NULL,
    "mappingMethod" TEXT NOT NULL,
    "targetIndex" DOUBLE PRECISION NOT NULL,
    "mappingConfidence" DOUBLE PRECISION NOT NULL,
    "mappingHash" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "scoredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptExamTargetScore_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConceptExamTargetScore_target_index_check" CHECK ("targetIndex" >= 0 AND "targetIndex" <= 1),
    CONSTRAINT "ConceptExamTargetScore_confidence_check" CHECK ("mappingConfidence" >= 0 AND "mappingConfidence" <= 1),
    CONSTRAINT "ConceptExamTargetScore_identity_check" CHECK (
        btrim("primaryDomainCode") <> ''
        AND btrim("mappingMethod") <> ''
        AND btrim("mappingHash") <> ''
        AND btrim("artifactHash") <> ''
    )
);

-- Snapshot score rows are append-only. Missing rows can therefore mean
-- legitimately neutral/new content after a successful read, while malformed
-- or unreadable rows still fail closed in the runtime repository. Inserts are
-- accepted only while the parent snapshot is in its pre-validation build
-- lifecycle; later changes require a new immutable snapshot revision.
CREATE FUNCTION "guard_exam_target_score_immutability"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    snapshot_status TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT "status" INTO snapshot_status
        FROM "ExamTargetSnapshot"
        WHERE "id" = NEW."targetSnapshotId";
        IF snapshot_status IS DISTINCT FROM 'built' THEN
            RAISE EXCEPTION 'exam target score rows can only be inserted into built snapshots'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'exam target score rows are immutable; create a new snapshot revision'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "ItemExamTargetScore_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "ItemExamTargetScore"
FOR EACH ROW EXECUTE FUNCTION "guard_exam_target_score_immutability"();

CREATE TRIGGER "ConceptExamTargetScore_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "ConceptExamTargetScore"
FOR EACH ROW EXECUTE FUNCTION "guard_exam_target_score_immutability"();

CREATE TABLE "ExamTargetActivation" (
    "id" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "targetSnapshotId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'shadow',
    "rolloutBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "activationRevision" INTEGER NOT NULL DEFAULT 1,
    "schedulerVersion" TEXT NOT NULL,
    "policyFingerprint" TEXT NOT NULL,
    "policyConfig" JSONB NOT NULL,
    "activatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedBy" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExamTargetActivation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExamTargetActivation_mode_check" CHECK ("mode" IN ('off', 'shadow', 'active')),
    CONSTRAINT "ExamTargetActivation_rollout_check" CHECK ("rolloutBasisPoints" >= 0 AND "rolloutBasisPoints" <= 10000),
    CONSTRAINT "ExamTargetActivation_revision_check" CHECK ("activationRevision" > 0)
);

CREATE TABLE "SchedulerDecisionSet" (
    "id" TEXT NOT NULL,
    "decisionKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "batchId" TEXT,
    "rotation" TEXT NOT NULL,
    "decisionPath" TEXT NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schedulerVersion" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "assignment" TEXT NOT NULL,
    "targetPolicyVersion" TEXT NOT NULL,
    "policyDigest" TEXT NOT NULL,
    "activationRevision" INTEGER,
    "targetSnapshotId" TEXT,
    "targetId" TEXT,
    "targetRevision" INTEGER,
    "targetBasis" TEXT,
    "targetScorerVersion" TEXT,
    "daysToExam" INTEGER,
    "pressureBucket" TEXT,
    "learnerStateVersion" TEXT,
    "sourcePolicy" JSONB,
    "masteryTelemetry" JSONB,
    "candidateSetDigest" TEXT,
    "tieBreakSeed" TEXT,
    "requestedSize" INTEGER NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "eligibleCount" INTEGER NOT NULL,
    "targetEligibleCount" INTEGER NOT NULL,
    "controlSelectedCount" INTEGER NOT NULL,
    "targetSelectedCount" INTEGER NOT NULL,
    "controlSelectionDigest" TEXT,
    "targetSelectionDigest" TEXT,
    "selectedSetOverlap" DOUBLE PRECISION,
    "changedMembershipCount" INTEGER,
    "controlMeanTargetScore" DOUBLE PRECISION,
    "targetMeanTargetScore" DOUBLE PRECISION,
    "pairedTargetLift" DOUBLE PRECISION,
    "controlAllocationError" DOUBLE PRECISION,
    "targetAllocationError" DOUBLE PRECISION,
    "targetComputeMs" INTEGER,
    "fallbackReason" TEXT,
    "traceVersion" INTEGER NOT NULL DEFAULT 1,
    "replaySnapshot" JSONB,
    "replayCapturedAt" TIMESTAMPTZ(3),
    "replayExpiresAt" TIMESTAMPTZ(3),

    CONSTRAINT "SchedulerDecisionSet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SchedulerDecisionSet_targeting_mode_check" CHECK ("mode" IN ('off', 'shadow', 'active', 'fallback')),
    CONSTRAINT "SchedulerDecisionSet_assignment_check" CHECK ("assignment" IN ('control', 'treatment', 'unassigned')),
    CONSTRAINT "SchedulerDecisionSet_target_basis_check" CHECK ("targetBasis" IS NULL OR "targetBasis" IN ('official', 'hybrid', 'proxy')),
    CONSTRAINT "SchedulerDecisionSet_activation_revision_check" CHECK ("activationRevision" IS NULL OR "activationRevision" > 0),
    CONSTRAINT "SchedulerDecisionSet_target_revision_check" CHECK ("targetRevision" IS NULL OR "targetRevision" > 0),
    CONSTRAINT "SchedulerDecisionSet_counts_check" CHECK (
        "requestedSize" >= 0
        AND "candidateCount" >= 0
        AND "eligibleCount" >= 0
        AND "targetEligibleCount" >= 0
        AND "controlSelectedCount" >= 0
        AND "targetSelectedCount" >= 0
        AND ("changedMembershipCount" IS NULL OR "changedMembershipCount" >= 0)
    ),
    CONSTRAINT "SchedulerDecisionSet_overlap_check" CHECK ("selectedSetOverlap" IS NULL OR ("selectedSetOverlap" >= 0 AND "selectedSetOverlap" <= 1)),
    CONSTRAINT "SchedulerDecisionSet_control_index_check" CHECK ("controlMeanTargetScore" IS NULL OR ("controlMeanTargetScore" >= 0 AND "controlMeanTargetScore" <= 1)),
    CONSTRAINT "SchedulerDecisionSet_target_index_check" CHECK ("targetMeanTargetScore" IS NULL OR ("targetMeanTargetScore" >= 0 AND "targetMeanTargetScore" <= 1)),
    CONSTRAINT "SchedulerDecisionSet_control_allocation_check" CHECK ("controlAllocationError" IS NULL OR ("controlAllocationError" >= 0 AND "controlAllocationError" <= 1)),
    CONSTRAINT "SchedulerDecisionSet_target_allocation_check" CHECK ("targetAllocationError" IS NULL OR ("targetAllocationError" >= 0 AND "targetAllocationError" <= 1)),
    CONSTRAINT "SchedulerDecisionSet_compute_time_check" CHECK ("targetComputeMs" IS NULL OR "targetComputeMs" >= 0),
    CONSTRAINT "SchedulerDecisionSet_trace_version_check" CHECK ("traceVersion" > 0),
    CONSTRAINT "SchedulerDecisionSet_snapshot_provenance_check" CHECK (
        (
            "targetSnapshotId" IS NULL
            AND "targetId" IS NULL
            AND "targetRevision" IS NULL
            AND "targetBasis" IS NULL
            AND "targetScorerVersion" IS NULL
        )
        OR (
            "targetSnapshotId" IS NOT NULL
            AND "targetId" IS NOT NULL
            AND "targetRevision" IS NOT NULL
            AND "targetBasis" IS NOT NULL
            AND "targetScorerVersion" IS NOT NULL
        )
    ),
    CONSTRAINT "SchedulerDecisionSet_mode_snapshot_check" CHECK (
        "mode" NOT IN ('shadow', 'active') OR "targetSnapshotId" IS NOT NULL
    ),
    CONSTRAINT "SchedulerDecisionSet_assignment_snapshot_check" CHECK (
        "assignment" <> 'treatment' OR "targetSnapshotId" IS NOT NULL
    ),
    CONSTRAINT "SchedulerDecisionSet_replay_window_check" CHECK (
        ("replaySnapshot" IS NULL AND "replayCapturedAt" IS NULL AND "replayExpiresAt" IS NULL)
        OR (
            "replaySnapshot" IS NOT NULL
            AND "replayCapturedAt" IS NOT NULL
            AND "replayExpiresAt" IS NOT NULL
            AND "replayExpiresAt" > "replayCapturedAt"
        )
    )
);

-- Existing history remains valid because every added column is nullable and has
-- no default. Writers can adopt target traces path-by-path without a rewrite.
ALTER TABLE "ServeDecision"
    ADD COLUMN "decisionSetId" TEXT,
    ADD COLUMN "examTargetSnapshotId" TEXT,
    ADD COLUMN "schedulerVersion" TEXT,
    ADD COLUMN "targetPolicyVersion" TEXT,
    ADD COLUMN "targetMode" TEXT,
    ADD COLUMN "targetAssignment" TEXT,
    ADD COLUMN "targetId" TEXT,
    ADD COLUMN "targetRevision" INTEGER,
    ADD COLUMN "targetBasis" TEXT,
    ADD COLUMN "targetScorerVersion" TEXT,
    ADD COLUMN "targetEmbeddingHash" TEXT,
    ADD COLUMN "targetActivationRevision" INTEGER,
    ADD COLUMN "targetRotation" TEXT,
    ADD COLUMN "sourceRotation" TEXT,
    ADD COLUMN "slotClass" TEXT,
    ADD COLUMN "targetEligible" BOOLEAN,
    ADD COLUMN "targetApplied" BOOLEAN,
    ADD COLUMN "targetBypassReason" TEXT,
    ADD COLUMN "targetDomainCode" TEXT,
    ADD COLUMN "targetPressureBucket" TEXT,
    ADD COLUMN "examRelevancePct" DOUBLE PRECISION,
    ADD COLUMN "examDomainWeight" DOUBLE PRECISION,
    ADD COLUMN "userDomainGap" DOUBLE PRECISION,
    ADD COLUMN "contentTargetScore" DOUBLE PRECISION,
    ADD COLUMN "personalizedTargetScore" DOUBLE PRECISION,
    ADD COLUMN "targetWeightProvenance" TEXT,
    ADD COLUMN "targetBoostDelta" DOUBLE PRECISION,
    ADD COLUMN "baseRankInPool" INTEGER,
    ADD COLUMN "targetRankInPool" INTEGER,
    ADD COLUMN "finalRankInPool" INTEGER,
    ADD COLUMN "targetChangedMembership" BOOLEAN,
    ADD COLUMN "targetCacheAgeMs" INTEGER,
    ADD COLUMN "targetTraceVersion" INTEGER,
    ADD COLUMN "targetTrace" JSONB;

CREATE UNIQUE INDEX "ExamTargetSnapshot_targetId_revision_key" ON "ExamTargetSnapshot"("targetId", "revision");
CREATE UNIQUE INDEX "ExamTargetSnapshot_id_rotation_key" ON "ExamTargetSnapshot"("id", "rotation");
CREATE UNIQUE INDEX "ExamTargetSnapshot_targetId_artifactHash_key" ON "ExamTargetSnapshot"("targetId", "artifactHash");
CREATE INDEX "ExamTargetSnapshot_rotation_status_validFrom_idx" ON "ExamTargetSnapshot"("rotation", "status", "validFrom");
CREATE INDEX "ExamTargetSnapshot_supersedesId_idx" ON "ExamTargetSnapshot"("supersedesId");
-- Prisma cannot represent a partial unique index. This target-only invariant
-- prevents registry status from naming two active artifacts for one rotation;
-- ExamTargetActivation remains the authoritative runtime pointer.
CREATE UNIQUE INDEX "ExamTargetSnapshot_one_active_per_rotation_key"
    ON "ExamTargetSnapshot"("rotation") WHERE "status" = 'active';

CREATE UNIQUE INDEX "ItemExamTargetScore_snapshot_item_embedding_key"
    ON "ItemExamTargetScore"("targetSnapshotId", "itemType", "itemId", "embeddingHash");
CREATE INDEX "ItemExamTargetScore_snapshot_item_idx"
    ON "ItemExamTargetScore"("targetSnapshotId", "itemType", "itemId");
CREATE INDEX "ItemExamTargetScore_snapshot_domain_target_idx"
    ON "ItemExamTargetScore"("targetSnapshotId", "domainCode", "itemTargetIndex");
CREATE INDEX "ItemExamTargetScore_sourceRotation_itemType_idx"
    ON "ItemExamTargetScore"("sourceRotation", "itemType");

CREATE UNIQUE INDEX "ConceptExamTargetScore_snapshot_concept_key"
    ON "ConceptExamTargetScore"("targetSnapshotId", "conceptId");
CREATE INDEX "ConceptExamTargetScore_snapshot_domain_target_idx"
    ON "ConceptExamTargetScore"("targetSnapshotId", "primaryDomainCode", "targetIndex");
CREATE INDEX "ConceptExamTargetScore_conceptId_scoredAt_idx"
    ON "ConceptExamTargetScore"("conceptId", "scoredAt");

CREATE UNIQUE INDEX "ExamTargetActivation_rotation_key" ON "ExamTargetActivation"("rotation");
CREATE INDEX "ExamTargetActivation_targetSnapshotId_idx" ON "ExamTargetActivation"("targetSnapshotId");

CREATE UNIQUE INDEX "SchedulerDecisionSet_decisionKey_key" ON "SchedulerDecisionSet"("decisionKey");
CREATE INDEX "SchedulerDecisionSet_userId_sessionId_batchId_idx" ON "SchedulerDecisionSet"("userId", "sessionId", "batchId");
CREATE INDEX "SchedulerDecisionSet_userId_decidedAt_idx" ON "SchedulerDecisionSet"("userId", "decidedAt");
CREATE INDEX "SchedulerDecisionSet_sessionId_idx" ON "SchedulerDecisionSet"("sessionId");
CREATE INDEX "SchedulerDecisionSet_rotation_mode_decidedAt_idx" ON "SchedulerDecisionSet"("rotation", "mode", "decidedAt");
CREATE INDEX "SchedulerDecisionSet_targetSnapshotId_decidedAt_idx" ON "SchedulerDecisionSet"("targetSnapshotId", "decidedAt");
CREATE INDEX "SchedulerDecisionSet_decidedAt_idx" ON "SchedulerDecisionSet"("decidedAt");
CREATE INDEX "SchedulerDecisionSet_replayExpiresAt_idx" ON "SchedulerDecisionSet"("replayExpiresAt");

ALTER TABLE "ExamTargetSnapshot"
    ADD CONSTRAINT "ExamTargetSnapshot_supersedesId_fkey"
    FOREIGN KEY ("supersedesId") REFERENCES "ExamTargetSnapshot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ItemExamTargetScore"
    ADD CONSTRAINT "ItemExamTargetScore_targetSnapshotId_fkey"
    FOREIGN KEY ("targetSnapshotId") REFERENCES "ExamTargetSnapshot"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConceptExamTargetScore"
    ADD CONSTRAINT "ConceptExamTargetScore_targetSnapshotId_fkey"
    FOREIGN KEY ("targetSnapshotId") REFERENCES "ExamTargetSnapshot"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConceptExamTargetScore"
    ADD CONSTRAINT "ConceptExamTargetScore_conceptId_fkey"
    FOREIGN KEY ("conceptId") REFERENCES "Concept"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExamTargetActivation"
    ADD CONSTRAINT "ExamTargetActivation_targetSnapshotId_rotation_fkey"
    FOREIGN KEY ("targetSnapshotId", "rotation") REFERENCES "ExamTargetSnapshot"("id", "rotation")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SchedulerDecisionSet"
    ADD CONSTRAINT "SchedulerDecisionSet_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SchedulerDecisionSet"
    ADD CONSTRAINT "SchedulerDecisionSet_targetSnapshotId_rotation_fkey"
    FOREIGN KEY ("targetSnapshotId", "rotation") REFERENCES "ExamTargetSnapshot"("id", "rotation")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- These constraints touch the pre-existing ServeDecision table. Add them as
-- NOT VALID first to keep the strongest lock short, then validate separately.
ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_snapshot_pair_check"
    CHECK (("examTargetSnapshotId" IS NULL) = ("targetRotation" IS NULL)) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_rotation_check"
    CHECK ("targetRotation" IS NULL OR "rotation" IS NULL OR "targetRotation" = "rotation") NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_basis_check"
    CHECK ("targetBasis" IS NULL OR "targetBasis" IN ('official', 'hybrid', 'proxy')) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_mode_check"
    CHECK ("targetMode" IS NULL OR "targetMode" IN ('off', 'shadow', 'active', 'fallback')) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_assignment_check"
    CHECK ("targetAssignment" IS NULL OR "targetAssignment" IN ('control', 'treatment')) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_slot_class_check"
    CHECK (
        "slotClass" IS NULL
        OR "slotClass" IN ('protected_due', 'protected_relearn', 'protected_failure', 'protected_scaffold', 'discretionary')
    ) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_revision_check"
    CHECK ("targetRevision" IS NULL OR "targetRevision" > 0) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_activation_revision_check"
    CHECK ("targetActivationRevision" IS NULL OR "targetActivationRevision" > 0) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_scores_check"
    CHECK (
        ("examRelevancePct" IS NULL OR ("examRelevancePct" >= 0 AND "examRelevancePct" <= 1))
        AND ("examDomainWeight" IS NULL OR ("examDomainWeight" >= 0 AND "examDomainWeight" <= 1))
        AND ("userDomainGap" IS NULL OR ("userDomainGap" >= 0 AND "userDomainGap" <= 1))
        AND ("contentTargetScore" IS NULL OR ("contentTargetScore" >= 0 AND "contentTargetScore" <= 1))
        AND ("personalizedTargetScore" IS NULL OR ("personalizedTargetScore" >= 0 AND "personalizedTargetScore" <= 1))
    ) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_ranks_check"
    CHECK (
        ("baseRankInPool" IS NULL OR "baseRankInPool" >= 0)
        AND ("targetRankInPool" IS NULL OR "targetRankInPool" >= 0)
        AND ("finalRankInPool" IS NULL OR "finalRankInPool" >= 0)
        AND ("targetCacheAgeMs" IS NULL OR "targetCacheAgeMs" >= 0)
    ) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_applied_check"
    CHECK (
        ("targetEligible" IS DISTINCT FROM TRUE OR "examTargetSnapshotId" IS NOT NULL)
        AND (
            "targetApplied" IS DISTINCT FROM TRUE
            OR ("examTargetSnapshotId" IS NOT NULL AND "targetEligible" IS TRUE)
        )
    ) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_target_trace_check"
    CHECK (
        ("targetTraceVersion" IS NULL OR "targetTraceVersion" > 0)
        AND ("targetTrace" IS NULL OR "targetTraceVersion" IS NOT NULL)
    ) NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_decisionSetId_fkey"
    FOREIGN KEY ("decisionSetId") REFERENCES "SchedulerDecisionSet"("id")
    ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ServeDecision"
    ADD CONSTRAINT "ServeDecision_examTargetSnapshotId_targetRotation_fkey"
    FOREIGN KEY ("examTargetSnapshotId", "targetRotation") REFERENCES "ExamTargetSnapshot"("id", "rotation")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_snapshot_pair_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_rotation_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_basis_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_mode_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_assignment_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_slot_class_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_revision_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_activation_revision_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_scores_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_ranks_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_applied_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_target_trace_check";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_decisionSetId_fkey";
ALTER TABLE "ServeDecision" VALIDATE CONSTRAINT "ServeDecision_examTargetSnapshotId_targetRotation_fkey";
