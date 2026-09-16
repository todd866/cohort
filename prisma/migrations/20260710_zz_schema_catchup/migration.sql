-- Historical production schema pushes left the committed migration chain
-- incomplete. A fresh database is still empty after the earlier migrations,
-- while production already has UserDocument and the current schema. Apply the
-- exact generated drift only to an empty fresh database; fail closed on a
-- populated partial database rather than risking destructive reconciliation.
DO $schema_catchup$
DECLARE
  candidate RECORD;
  has_rows BOOLEAN;
BEGIN
  IF to_regclass('public."UserDocument"') IS NULL THEN
    -- Fresh migration databases have no application rows. Checking User alone
    -- is insufficient: a content-populated/zero-user partial database would
    -- otherwise enter the destructive DROP section below. Fail closed if any
    -- application table contains even one row.
    FOR candidate IN
      SELECT schemaname, tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
      ORDER BY tablename
    LOOP
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)',
        candidate.schemaname,
        candidate.tablename
      ) INTO has_rows;
      IF has_rows THEN
        RAISE EXCEPTION
          'Refusing schema catch-up on populated partial database (table %)',
          candidate.tablename;
      END IF;
    END LOOP;

-- DropForeignKey
ALTER TABLE "Card" DROP CONSTRAINT "Card_wikiArticleId_fkey";

-- DropForeignKey
ALTER TABLE "CardVersion" DROP CONSTRAINT "CardVersion_cardId_fkey";

-- DropForeignKey
ALTER TABLE "ContentInteraction" DROP CONSTRAINT "ContentInteraction_userId_fkey";

-- DropForeignKey
ALTER TABLE "ContentIssueReport" DROP CONSTRAINT "ContentIssueReport_issueId_fkey";

-- DropForeignKey
ALTER TABLE "ContentIssueReport" DROP CONSTRAINT "ContentIssueReport_userId_fkey";

-- DropForeignKey
ALTER TABLE "DailyPulse" DROP CONSTRAINT "DailyPulse_userId_fkey";

-- DropForeignKey
ALTER TABLE "Fact" DROP CONSTRAINT "Fact_wikiArticleId_fkey";

-- DropForeignKey
ALTER TABLE "FeedEvent" DROP CONSTRAINT "FeedEvent_sessionFingerprint_fkey";

-- DropForeignKey
ALTER TABLE "FeedbackReasoningLink" DROP CONSTRAINT "FeedbackReasoningLink_rationaleId_fkey";

-- DropForeignKey
ALTER TABLE "GenerationRationale" DROP CONSTRAINT "GenerationRationale_conceptTestId_fkey";

-- DropForeignKey
ALTER TABLE "GenerationRationale" DROP CONSTRAINT "GenerationRationale_moduleId_fkey";

-- DropForeignKey
ALTER TABLE "GlossaryTerm" DROP CONSTRAINT "GlossaryTerm_domainId_fkey";

-- DropForeignKey
ALTER TABLE "GuidelineChunk" DROP CONSTRAINT "GuidelineChunk_citationId_fkey";

-- DropForeignKey
ALTER TABLE "GuidelineChunk" DROP CONSTRAINT "GuidelineChunk_guidelineId_fkey";

-- DropForeignKey
ALTER TABLE "GuidelineSource" DROP CONSTRAINT "GuidelineSource_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "HarvestEvent" DROP CONSTRAINT "HarvestEvent_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "HarvestSession" DROP CONSTRAINT "HarvestSession_userId_fkey";

-- DropForeignKey
ALTER TABLE "LearningEvent" DROP CONSTRAINT "LearningEvent_cardVersionId_fkey";

-- DropForeignKey
ALTER TABLE "PedagogicalConceptTest" DROP CONSTRAINT "PedagogicalConceptTest_moduleId_fkey";

-- DropForeignKey
ALTER TABLE "PedagogicalPattern" DROP CONSTRAINT "PedagogicalPattern_moduleId_fkey";

-- DropForeignKey
ALTER TABLE "PipelineRun" DROP CONSTRAINT "PipelineRun_questionId_fkey";

-- DropForeignKey
ALTER TABLE "QuestionGroupAttempt" DROP CONSTRAINT "QuestionGroupAttempt_groupId_fkey";

-- DropForeignKey
ALTER TABLE "SessionSnapshot" DROP CONSTRAINT "SessionSnapshot_userId_fkey";

-- DropForeignKey
ALTER TABLE "SkillProgress" DROP CONSTRAINT "SkillProgress_skillId_fkey";

-- DropForeignKey
ALTER TABLE "SkillSession" DROP CONSTRAINT "SkillSession_skillId_fkey";

-- DropForeignKey
ALTER TABLE "SnippetConcept" DROP CONSTRAINT "SnippetConcept_conceptId_fkey";

-- DropForeignKey
ALTER TABLE "SnippetConcept" DROP CONSTRAINT "SnippetConcept_snippetId_fkey";

-- DropForeignKey
ALTER TABLE "SourceArtifact" DROP CONSTRAINT "SourceArtifact_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "TransferObservation" DROP CONSTRAINT "TransferObservation_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserBehaviorProfile" DROP CONSTRAINT "UserBehaviorProfile_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserWBAProgress" DROP CONSTRAINT "UserWBAProgress_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserWBAProgress" DROP CONSTRAINT "UserWBAProgress_wbaId_fkey";

-- DropForeignKey
ALTER TABLE "UsydMd1AnatomyProgress" DROP CONSTRAINT "UsydMd1AnatomyProgress_cardId_fkey";

-- DropIndex
DROP INDEX "AnatomyRegion_slug_idx";

-- DropIndex
DROP INDEX "Card_embeddingId_key";

-- DropIndex
DROP INDEX "Card_wikiArticleId_idx";

-- DropIndex
DROP INDEX "ContentIssue_targetType_targetId_issueType_status_key";

-- DropIndex
DROP INDEX "DailyStats_userId_date_idx";

-- DropIndex
DROP INDEX "DeepDiveChatSession_userId_deepDiveSlug_idx";

-- DropIndex
DROP INDEX "Fact_wikiArticleId_idx";

-- DropIndex
DROP INDEX "GlossaryTerm_domainId_abbr_key";

-- DropIndex
DROP INDEX "GlossaryTerm_domainId_idx";

-- DropIndex
DROP INDEX "LearningEvent_cardVersionId_idx";

-- DropIndex
DROP INDEX "UserEmail_email_idx";

-- AlterTable
ALTER TABLE "AgentJob" ALTER COLUMN "claimedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "completedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "AnatomyRegion" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "AnatomyStructure" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "AnonymousSession" ADD COLUMN     "profile" JSONB,
ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastActiveAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Card" DROP COLUMN "embeddingId",
DROP COLUMN "wikiArticleId",
ADD COLUMN     "examDomain" TEXT,
ADD COLUMN     "examDomainSim" DOUBLE PRECISION,
ADD COLUMN     "examRelevancePct" DOUBLE PRECISION,
ADD COLUMN     "imageRole" TEXT,
ALTER COLUMN "week" DROP NOT NULL,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "CardCitation" ALTER COLUMN "addedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "verifiedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "CardExamRelevance" ALTER COLUMN "computedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "CardProgress" ADD COLUMN     "leechReplacementCardId" TEXT,
ADD COLUMN     "leechSuppressedUntil" TIMESTAMPTZ(3),
ADD COLUMN     "leechSuppressionCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "nextDueAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastReview" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "flaggedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "feedbackAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "masteredAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "recentFailWindowStart" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastFailedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "viewsTodayDate" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "CitationAuditLog" ALTER COLUMN "occurredAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "CitationCheck" ALTER COLUMN "checkedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "CitationSnapshot" ALTER COLUMN "urlAccessedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastModified" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Cluster" ADD COLUMN     "videoCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Concept" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ConceptState" ALTER COLUMN "lastProbeAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastExposureAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "localKnowledgeUpdatedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastComputed" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ContentAudit" ALTER COLUMN "auditedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ContentAuditItem" ALTER COLUMN "lastAuditedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "nextAuditAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "hashChangedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ContentExposure" ALTER COLUMN "timestamp" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ContentGap" ALTER COLUMN "detectedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ContentIssue" ADD COLUMN     "triagedAt" TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "trustReviewedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "DeepDiveChatMessage" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "DeepDiveChatSession" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ExamDefinition" ALTER COLUMN "examDate" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Fact" DROP COLUMN "wikiArticleId",
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "GlossaryTerm" DROP COLUMN "domainId",
ADD COLUMN     "domain" TEXT NOT NULL DEFAULT 'medicine',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "LearningEvent" DROP COLUMN "cardVersionId",
ADD COLUMN     "contentVersionId" TEXT,
ALTER COLUMN "timestamp" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "MedicalTerm" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ModuleNode" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "PageView" ALTER COLUMN "viewedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "examDomain" TEXT,
ADD COLUMN     "examDomainSim" DOUBLE PRECISION,
ADD COLUMN     "examRelevancePct" DOUBLE PRECISION,
ALTER COLUMN "validatedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "enhancedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "citedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "promotedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "escalatedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "QuestionGroup" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "QuestionResponse" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ReviewSession" ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "completedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "expires" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Source" ALTER COLUMN "lastUpdated" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "SourceCitation" ALTER COLUMN "verifiedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "StruggleIntervention" ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "TeachingSignal" ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "TermEvent" ALTER COLUMN "timestamp" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "User" DROP COLUMN "undfYear",
ADD COLUMN     "betaAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "feedProfile" JSONB,
ADD COLUMN     "imageTier" TEXT NOT NULL DEFAULT 'standard',
ALTER COLUMN "emailVerified" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastActiveAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "UserClusterState" ALTER COLUMN "lastReviewedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastComputedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "UserEmail" ALTER COLUMN "verifiedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "UserFeedback" ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "UserRotation" ALTER COLUMN "startDate" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "examDate" SET DATA TYPE TIMESTAMPTZ(3);

-- The historical column was JSONB. This guarded catch-up runs only on a fresh,
-- empty database, so replace it instead of relying on an unsafe implicit cast.
ALTER TABLE "UserStruggleRegion" DROP COLUMN "centroidEmbedding";
ALTER TABLE "UserStruggleRegion" ADD COLUMN "centroidEmbedding" halfvec(3072);
ALTER TABLE "UserStruggleRegion" ALTER COLUMN "activeSince" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastUpdated" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "UserStudyQueue" ALTER COLUMN "computedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "validUntil" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "UserTermState" ALTER COLUMN "lastExposureAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastHoverAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lastQuizAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "VerificationToken" ALTER COLUMN "expires" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "_FactToSourceCitation" ADD CONSTRAINT "_FactToSourceCitation_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_FactToSourceCitation_AB_unique";

-- AlterTable
ALTER TABLE "card_embeddings" ADD COLUMN     "embedding" halfvec(3072) NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "citation_embeddings" ADD COLUMN     "embedding" halfvec(3072) NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "concept_subspaces" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "computed_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "courseware_embeddings" ADD COLUMN     "embedding" halfvec(3072) NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "question_embeddings" ADD COLUMN     "embedding" halfvec(3072) NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- DropTable
DROP TABLE "CardTypePreference";

-- DropTable
DROP TABLE "CardVersion";

-- DropTable
DROP TABLE "ContentFeedback";

-- DropTable
DROP TABLE "ContentImage";

-- DropTable
DROP TABLE "ContentInteraction";

-- DropTable
DROP TABLE "ContentIssueReport";

-- DropTable
DROP TABLE "DailyPulse";

-- DropTable
DROP TABLE "Embedding";

-- DropTable
DROP TABLE "FeedbackReasoningLink";

-- DropTable
DROP TABLE "GenerationRationale";

-- DropTable
DROP TABLE "GlossaryDomain";

-- DropTable
DROP TABLE "GuidelineChunk";

-- DropTable
DROP TABLE "GuidelineSource";

-- DropTable
DROP TABLE "HarvestEvent";

-- DropTable
DROP TABLE "HarvestSession";

-- DropTable
DROP TABLE "ImageOcclusionAttempt";

-- DropTable
DROP TABLE "MCQExposure";

-- DropTable
DROP TABLE "Module";

-- DropTable
DROP TABLE "PageMetadata";

-- DropTable
DROP TABLE "PedagogicalConceptTest";

-- DropTable
DROP TABLE "PedagogicalPattern";

-- DropTable
DROP TABLE "PipelineRun";

-- DropTable
DROP TABLE "PulseEntry";

-- DropTable
DROP TABLE "QuestionGroupAttempt";

-- DropTable
DROP TABLE "SessionSnapshot";

-- DropTable
DROP TABLE "Skill";

-- DropTable
DROP TABLE "SkillProgress";

-- DropTable
DROP TABLE "SkillSession";

-- DropTable
DROP TABLE "SnippetConcept";

-- DropTable
DROP TABLE "SourceArtifact";

-- DropTable
DROP TABLE "TableQuizAttempt";

-- DropTable
DROP TABLE "TeachingSnippet";

-- DropTable
DROP TABLE "TopicPreference";

-- DropTable
DROP TABLE "TransferObservation";

-- DropTable
DROP TABLE "UserBehaviorProfile";

-- DropTable
DROP TABLE "UserWBAProgress";

-- DropTable
DROP TABLE "UsydMd1AnatomyCard";

-- DropTable
DROP TABLE "UsydMd1AnatomyProgress";

-- DropTable
DROP TABLE "WBADefinition";

-- DropTable
DROP TABLE "WikiArticle";

-- DropEnum
DROP TYPE "HarvestEventStatus";

-- DropEnum
DROP TYPE "HarvestEventType";

-- DropEnum
DROP TYPE "HarvestSessionStatus";

-- CreateTable
CREATE TABLE "UserDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentVersion" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_embeddings" (
    "id" TEXT NOT NULL,
    "concept_id" TEXT NOT NULL,
    "embedding" halfvec(3072) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "rotation" TEXT,
    "topics" TEXT[],
    "score" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SyncOperation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientOperationId" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quality" INTEGER,
    "isCorrect" BOOLEAN,
    "selectedOption" TEXT,
    "responseMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserDocument_userId_idx" ON "UserDocument"("userId");

-- CreateIndex
CREATE INDEX "ContentVersion_targetType_targetId_idx" ON "ContentVersion"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ContentVersion_createdAt_idx" ON "ContentVersion"("createdAt");

-- CreateIndex
CREATE INDEX "ContentVersion_contentHash_idx" ON "ContentVersion"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ContentVersion_targetType_targetId_versionNumber_key" ON "ContentVersion"("targetType", "targetId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "concept_embeddings_concept_id_key" ON "concept_embeddings"("concept_id");

-- CreateIndex
CREATE INDEX "AssessmentAttempt_userId_attemptType_idx" ON "AssessmentAttempt"("userId", "attemptType");

-- CreateIndex
CREATE INDEX "AssessmentAttempt_userId_rotation_idx" ON "AssessmentAttempt"("userId", "rotation");

-- CreateIndex
CREATE INDEX "AssessmentAttempt_targetId_idx" ON "AssessmentAttempt"("targetId");

-- CreateIndex
CREATE INDEX "SyncOperation_processedAt_idx" ON "SyncOperation"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncOperation_userId_clientOperationId_key" ON "SyncOperation"("userId", "clientOperationId");

-- CreateIndex
CREATE INDEX "SandboxAttempt_userId_runId_createdAt_idx" ON "SandboxAttempt"("userId", "runId", "createdAt");

-- CreateIndex
CREATE INDEX "SandboxAttempt_userId_createdAt_idx" ON "SandboxAttempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Card_examDomain_idx" ON "Card"("examDomain");

-- CreateIndex
CREATE INDEX "CardProgress_userId_status_idx" ON "CardProgress"("userId", "status");

-- CreateIndex
CREATE INDEX "GlossaryTerm_domain_idx" ON "GlossaryTerm"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryTerm_domain_abbr_key" ON "GlossaryTerm"("domain", "abbr");

-- CreateIndex
CREATE INDEX "LearningEvent_contentVersionId_idx" ON "LearningEvent"("contentVersionId");

-- CreateIndex
CREATE INDEX "Question_examDomain_idx" ON "Question"("examDomain");

-- CreateIndex
CREATE INDEX "ReviewSession_userId_idx" ON "ReviewSession"("userId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "UserDocument" ADD CONSTRAINT "UserDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedEvent" ADD CONSTRAINT "FeedEvent_sessionFingerprint_fkey" FOREIGN KEY ("sessionFingerprint") REFERENCES "AnonymousSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_contentVersionId_fkey" FOREIGN KEY ("contentVersionId") REFERENCES "ContentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncOperation" ADD CONSTRAINT "SyncOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$schema_catchup$;
