-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "HarvestSessionStatus" AS ENUM ('ACTIVE', 'ENDED', 'PROCESSED');

-- CreateEnum
CREATE TYPE "HarvestEventType" AS ENUM ('PAGE_TEXT', 'CAPTION', 'COPY', 'INPUT', 'PDF_PAGE');

-- CreateEnum
CREATE TYPE "HarvestEventStatus" AS ENUM ('PENDING', 'CLASSIFIED', 'APPROVED', 'REJECTED', 'INGESTED');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "cohort" INTEGER,
    "medSchool" TEXT,
    "studyGoal" INTEGER,
    "track" INTEGER,
    "ccSubrotation" TEXT,
    "institution" TEXT,
    "undfYear" INTEGER,
    "enabledModules" TEXT[] DEFAULT ARRAY['ecg', 'cxr', 'abg']::TEXT[],
    "activeModules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "jurisdiction" TEXT,
    "darkMode" BOOLEAN NOT NULL DEFAULT false,
    "emailDigest" BOOLEAN NOT NULL DEFAULT true,
    "preferAbbreviations" BOOLEAN NOT NULL DEFAULT false,
    "totalStudyTime" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEmail" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "label" TEXT,

    CONSTRAINT "UserEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnonymousSession" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "userId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cardsViewed" INTEGER NOT NULL DEFAULT 0,
    "mcqsAttempted" INTEGER NOT NULL DEFAULT 0,
    "pagesRead" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnonymousSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentJob" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "rotation" TEXT,
    "conceptId" TEXT,
    "cardId" TEXT,
    "questionId" TEXT,
    "trigger" TEXT NOT NULL,
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "UserRotation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "examDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleNode" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentSlug" TEXT,
    "nodeType" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rotations" TEXT[],
    "cardCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserClusterState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "mastery" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgRetrieval" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "coverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cardsReviewed" INTEGER NOT NULL DEFAULT 0,
    "cardsTotal" INTEGER NOT NULL DEFAULT 0,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "lastReviewedAt" TIMESTAMP(3),
    "lastComputedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserClusterState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" TEXT NOT NULL,
    "cardType" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "moduleNodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceFile" TEXT,
    "sourceComponent" TEXT NOT NULL,
    "stableId" TEXT,
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "backs" JSONB,
    "context" TEXT,
    "topics" TEXT[],
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "importance" INTEGER NOT NULL DEFAULT 1,
    "complexity" INTEGER NOT NULL DEFAULT 2,
    "jurisdiction" TEXT,
    "conceptId" TEXT,
    "visualData" JSONB,
    "annotations" JSONB,
    "abbreviations" JSONB,
    "crosslinks" JSONB,
    "imageUrl" TEXT,
    "embeddingId" TEXT,
    "clusterId" TEXT,
    "similarCards" JSONB,
    "wikiArticleId" TEXT,
    "factId" TEXT,
    "quality" JSONB,
    "pedagogy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Embedding" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Embedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_embeddings" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "card_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_embeddings" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "question_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courseware_embeddings" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "chunk_id" TEXT NOT NULL,
    "source_file" TEXT NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT 'lecture',
    "rotation" TEXT NOT NULL,
    "week" INTEGER,
    "chunk_index" INTEGER NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courseware_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_subspaces" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "concept_id" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "pca_mean" JSONB NOT NULL,
    "pca_basis" JSONB NOT NULL,
    "explained_variance" JSONB NOT NULL,
    "total_variance_explained" DOUBLE PRECISION NOT NULL,
    "local_centroid" JSONB NOT NULL,
    "item_count" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_subspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardProgress" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stabilityDays" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "nextDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReview" TIMESTAMP(3),
    "lastQuality" INTEGER,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "liked" BOOLEAN NOT NULL DEFAULT false,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flaggedAt" TIMESTAMP(3),
    "flagReason" TEXT,
    "flagContext" JSONB,
    "feedbackAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'learning',
    "avgResponseTimeMs" INTEGER,
    "consecutiveCorrectFast" INTEGER NOT NULL DEFAULT 0,
    "masteredAt" TIMESTAMP(3),
    "retrievalStrength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confusedWith" TEXT[],
    "reviewContext" JSONB,
    "recentFailCount" INTEGER NOT NULL DEFAULT 0,
    "recentFailWindowStart" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "viewsToday" INTEGER NOT NULL DEFAULT 0,
    "viewsTodayDate" TIMESTAMP(3),

    CONSTRAINT "CardProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "cardsReviewed" JSONB NOT NULL,
    "clustersHit" TEXT[],

    CONSTRAINT "ReviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TableQuizAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "topics" TEXT[],
    "score" INTEGER NOT NULL,
    "totalCells" INTEGER NOT NULL,
    "correctCells" INTEGER NOT NULL,
    "cellResults" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableQuizAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageOcclusionAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "topics" TEXT[],
    "score" INTEGER NOT NULL,
    "totalRegions" INTEGER NOT NULL,
    "correctRegions" INTEGER NOT NULL,
    "regionResults" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageOcclusionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageView" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "rotation" TEXT,
    "week" INTEGER,
    "duration" INTEGER,
    "scrollDepth" DOUBLE PRECISION,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageMetadata" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "headingCount" INTEGER NOT NULL DEFAULT 0,
    "componentCount" INTEGER NOT NULL DEFAULT 0,
    "estimatedReadingMinutes" DOUBLE PRECISION NOT NULL,
    "rotation" TEXT,
    "week" INTEGER,
    "conceptIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentInteraction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "componentId" TEXT,
    "action" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "rotation" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyStats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "cardsReviewed" INTEGER NOT NULL DEFAULT 0,
    "cardsCorrect" INTEGER NOT NULL DEFAULT 0,
    "newCardsSeen" INTEGER NOT NULL DEFAULT 0,
    "studyTimeMin" INTEGER NOT NULL DEFAULT 0,
    "studyTimeMs" INTEGER NOT NULL DEFAULT 0,
    "pagesViewed" INTEGER NOT NULL DEFAULT 0,
    "quizzesTaken" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardTypePreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "preference" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardTypePreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "preference" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "briefing" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PulseEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyPulse" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sections" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT NOT NULL DEFAULT 'claude-code',
    "gaps" JSONB,

    CONSTRAINT "DailyPulse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "description" TEXT,
    "contentSnapshot" TEXT,
    "path" TEXT,
    "rotation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ContentFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentIssue" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "reportCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "resolutionEvidence" JSONB,
    "metadata" JSONB,
    "contentSnapshot" TEXT,
    "path" TEXT,
    "rotation" TEXT,

    CONSTRAINT "ContentIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentIssueReport" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "userId" TEXT,
    "reporterType" TEXT NOT NULL DEFAULT 'user',
    "reason" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentIssueReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentAuditItem" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "rotation" TEXT,
    "week" INTEGER,
    "sourceFile" TEXT,
    "institution" TEXT,
    "jurisdiction" TEXT NOT NULL,
    "safetyCritical" BOOLEAN NOT NULL DEFAULT true,
    "harmDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "harmSeverity" TEXT,
    "riskTier" TEXT NOT NULL DEFAULT 'medium',
    "riskScore" DOUBLE PRECISION,
    "riskSignals" JSONB,
    "auditIntervalDays" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'needs-audit',
    "lastAuditedAt" TIMESTAMP(3),
    "nextAuditAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "lastAuditedHash" TEXT,
    "currentHash" TEXT,
    "hashChangedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentAuditItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentAudit" (
    "id" TEXT NOT NULL,
    "auditItemId" TEXT NOT NULL,
    "auditedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auditedBy" TEXT,
    "jurisdiction" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "notes" TEXT,
    "sourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "citationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "artifactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contentHash" TEXT NOT NULL,
    "contentSnippet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceArtifact" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT,
    "jurisdiction" TEXT NOT NULL,
    "artifactType" TEXT NOT NULL,
    "storageUri" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "checksum" TEXT,
    "byteSize" INTEGER,
    "url" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "versionLabel" TEXT,
    "license" TEXT,
    "ipRestricted" BOOLEAN NOT NULL DEFAULT true,
    "usagePolicy" TEXT,
    "accessNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Concept" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rotation" TEXT NOT NULL,
    "week" INTEGER,
    "topics" TEXT[],
    "examWeight" INTEGER NOT NULL DEFAULT 1,
    "frequency" TEXT,
    "prerequisiteIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentGap" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT,
    "rotation" TEXT NOT NULL,
    "gapType" TEXT NOT NULL,
    "nearestSimilarity" DOUBLE PRECISION NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ContentGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "explanation" TEXT,
    "rotation" TEXT NOT NULL,
    "week" INTEGER,
    "topics" TEXT[],
    "moduleNodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "sourceFile" TEXT,
    "questionNumber" INTEGER,
    "questionType" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "variantGroupId" TEXT,
    "variantType" TEXT,
    "discriminationIndex" DOUBLE PRECISION,
    "facilityIndex" DOUBLE PRECISION,
    "totalAttempts" INTEGER NOT NULL DEFAULT 0,
    "combinations" JSONB,
    "correctVariants" JSONB,
    "chainId" TEXT,
    "chainOrder" INTEGER,
    "imageUrl" TEXT,
    "crosslinks" JSONB,
    "annotations" JSONB,
    "abbreviations" JSONB,
    "cardId" TEXT,
    "contentState" TEXT NOT NULL DEFAULT 'raw',
    "validatedAt" TIMESTAMP(3),
    "enhancedAt" TIMESTAMP(3),
    "citedAt" TIMESTAMP(3),
    "promotedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "escalationReason" TEXT,
    "citations" JSONB,
    "pedagogy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "questionId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "promptUsed" TEXT NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "parsedOutput" JSONB,
    "success" BOOLEAN NOT NULL,
    "errorType" TEXT,
    "errorMessage" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "tokenCount" INTEGER,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionConcept" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "QuestionConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionResponse" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedOption" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "responseTimeMs" INTEGER,
    "sessionType" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "confidence" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardVersion" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "backs" JSONB,
    "context" TEXT,
    "topics" TEXT[],
    "difficulty" TEXT NOT NULL,
    "imageUrl" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "auditItemId" TEXT,
    "contentHash" TEXT,
    "cardVersionId" TEXT,
    "quality" INTEGER,
    "isCorrect" BOOLEAN,
    "responseMs" INTEGER,
    "metadata" JSONB,
    "conceptIds" TEXT[],
    "rotation" TEXT,
    "week" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "recallProbability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recallOnExamDay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "decayRate" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "lastProbeAt" TIMESTAMP(3),
    "lastExposureAt" TIMESTAMP(3),
    "avgResponseMs" DOUBLE PRECISION,
    "responseVariance" DOUBLE PRECISION,
    "recentFailRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inStruggleRegion" BOOLEAN NOT NULL DEFAULT false,
    "exposureCount" INTEGER NOT NULL DEFAULT 0,
    "probeCount" INTEGER NOT NULL DEFAULT 0,
    "localKnowledgeVector" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "localKnowledgeUpdatedAt" TIMESTAMP(3),
    "lastComputed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStruggleRegion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "failedCardIds" TEXT[],
    "centroidEmbedding" BYTEA,
    "totalFailCount" INTEGER NOT NULL DEFAULT 0,
    "avgFailsPerCard" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgResponseMs" DOUBLE PRECISION,
    "activeSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "UserStruggleRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StruggleIntervention" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "triggerCardId" TEXT NOT NULL,
    "failCount" INTEGER NOT NULL,
    "regionSnapshot" JSONB,
    "strategy" TEXT NOT NULL,
    "scaffoldCardIds" TEXT[],
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "attemptsToResolve" INTEGER,
    "triggerCardNextQuality" INTEGER,
    "resolutionConfidence" DOUBLE PRECISION,
    "stillFragile" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StruggleIntervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeachingSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "interventionType" TEXT NOT NULL,
    "conceptIds" TEXT[],
    "primaryConceptId" TEXT,
    "preRecallProbability" DOUBLE PRECISION NOT NULL,
    "preConfidence" DOUBLE PRECISION NOT NULL,
    "preExposureCount" INTEGER NOT NULL,
    "predictedMasteryDelta" DOUBLE PRECISION NOT NULL,
    "predictedOutcome" TEXT,
    "actualMasteryDelta" DOUBLE PRECISION,
    "actualOutcome" TEXT,
    "quality" INTEGER,
    "isCorrect" BOOLEAN,
    "responseTimeMs" INTEGER,
    "predictionError" DOUBLE PRECISION,
    "postRecallProbability" DOUBLE PRECISION,
    "postConfidence" DOUBLE PRECISION,
    "sessionPosition" INTEGER,
    "daysToExam" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeachingSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeachingSnippet" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pre_teach',
    "rotation" TEXT NOT NULL,
    "week" INTEGER,
    "topics" TEXT[],
    "moduleNodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "wordCount" INTEGER,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "embeddingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeachingSnippet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnippetConcept" (
    "id" TEXT NOT NULL,
    "snippetId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SnippetConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "halfLifeDays" INTEGER NOT NULL DEFAULT 14,
    "subskills" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "totalQuestions" INTEGER NOT NULL,
    "correctAnswers" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "subskillResults" JSONB,
    "details" JSONB,

    CONSTRAINT "SkillSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "totalSessions" INTEGER NOT NULL DEFAULT 0,
    "totalQuestions" INTEGER NOT NULL DEFAULT 0,
    "totalCorrect" INTEGER NOT NULL DEFAULT 0,
    "overallAccuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastPracticed" TIMESTAMP(3),
    "streakDays" INTEGER NOT NULL DEFAULT 0,
    "subskillAccuracy" JSONB,
    "estimatedStrength" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "lastComputed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WikiArticle" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "week" INTEGER,
    "topics" TEXT[],
    "sources" TEXT[],
    "relatedSlugs" TEXT[],
    "wordCount" INTEGER,
    "estimatedReadingMinutes" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WikiArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "reliability" INTEGER NOT NULL DEFAULT 3,
    "jurisdiction" TEXT,
    "publisher" TEXT,
    "url" TEXT,
    "lastUpdated" TIMESTAMP(3),
    "aliases" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceCitation" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "page" TEXT,
    "section" TEXT,
    "level1Text" TEXT NOT NULL,
    "level2Quote" TEXT,
    "level2Context" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "currentSnapshotId" TEXT,
    "stabilityTier" TEXT NOT NULL DEFAULT 'procedural',
    "auditIntervalDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardCitation" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "relationship" TEXT NOT NULL DEFAULT 'supports',
    "jurisdictionNote" TEXT,
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "CardCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationSnapshot" (
    "id" TEXT NOT NULL,
    "citationId" TEXT NOT NULL,
    "url" TEXT,
    "urlAccessedAt" TIMESTAMP(3) NOT NULL,
    "contentRaw" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contentType" TEXT,
    "extractedText" TEXT,
    "extractedQuote" TEXT,
    "pageTitle" TEXT,
    "lastModified" TIMESTAMP(3),
    "httpStatus" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationAuditLog" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "previousUrl" TEXT,
    "newUrl" TEXT,
    "previousHash" TEXT,
    "newHash" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationCheck" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "httpStatus" INTEGER,
    "contentHash" TEXT,
    "urlChanged" BOOLEAN NOT NULL DEFAULT false,
    "contentChanged" BOOLEAN NOT NULL DEFAULT false,
    "isAccessible" BOOLEAN NOT NULL DEFAULT true,
    "newSnapshotId" TEXT,

    CONSTRAINT "CitationCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuidelineSource" (
    "id" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "contentHash" TEXT,
    "version" TEXT,
    "publishedAt" TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastChecked" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentMarkdown" TEXT,
    "category" TEXT,
    "topics" TEXT[],
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidelineSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuidelineChunk" (
    "id" TEXT NOT NULL,
    "guidelineId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "sectionPath" TEXT,
    "sectionTitle" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "tokenCount" INTEGER,
    "citationId" TEXT,

    CONSTRAINT "GuidelineChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citation_embeddings" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "citation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citation_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fact" (
    "id" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "citations" TEXT[],
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "rotation" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "topics" TEXT[],
    "examWeight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "prerequisiteIds" TEXT[],
    "embedding" vector(256),
    "wikiArticleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactConcept" (
    "id" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FactConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionFact" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "QuestionFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ALSSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "scenarioId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "outcome" TEXT,
    "totalCycles" INTEGER NOT NULL DEFAULT 0,
    "totalShocks" INTEGER NOT NULL DEFAULT 0,
    "overallScore" INTEGER,
    "adrenalineScore" INTEGER,
    "amiodaroneScore" INTEGER,
    "pathwayAdherenceScore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ALSSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ALSEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "ALSEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ALSScenario" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "initialRhythm" TEXT NOT NULL,
    "transitions" JSONB NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "expectedOutcome" TEXT NOT NULL,
    "learningObjectives" TEXT[],
    "conceptIds" TEXT[],
    "rotation" TEXT NOT NULL DEFAULT 'critical-care',
    "totalAttempts" INTEGER NOT NULL DEFAULT 0,
    "avgScore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ALSScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlossaryDomain" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlossaryDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlossaryTerm" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "abbr" TEXT NOT NULL,
    "full" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "related" TEXT[],
    "category" TEXT,
    "complexity" INTEGER NOT NULL DEFAULT 1,
    "totalLookups" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlossaryTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTermState" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "termId" TEXT NOT NULL,
    "exposureCount" INTEGER NOT NULL DEFAULT 0,
    "hoverCount" INTEGER NOT NULL DEFAULT 0,
    "lastExposureAt" TIMESTAMP(3),
    "lastHoverAt" TIMESTAMP(3),
    "disclosureLevel" INTEGER NOT NULL DEFAULT 0,
    "masteryScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quizAttempts" INTEGER NOT NULL DEFAULT 0,
    "quizCorrect" INTEGER NOT NULL DEFAULT 0,
    "lastQuizAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTermState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "termId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TermEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStudyQueue" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "dueCards" INTEGER NOT NULL DEFAULT 0,
    "weakCards" INTEGER NOT NULL DEFAULT 0,
    "newCards" INTEGER NOT NULL DEFAULT 0,
    "questions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserStudyQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCQExposure" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "questionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "interacted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MCQExposure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeepDiveChatSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deepDiveSlug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeepDiveChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeepDiveChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeepDiveChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionGroup" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "contextImageUrl" TEXT,
    "contextText" TEXT,
    "steps" JSONB NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "topics" TEXT[],
    "rotation" TEXT,
    "week" INTEGER,
    "diagnosisSummary" TEXT,
    "totalAttempts" INTEGER NOT NULL DEFAULT 0,
    "avgScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionGroupAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "stepResults" JSONB NOT NULL,
    "correctCount" INTEGER NOT NULL,
    "totalSteps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionGroupAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WBADefinition" (
    "id" TEXT NOT NULL,
    "rotation" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "choiceGroup" TEXT,
    "assessor" TEXT NOT NULL,
    "details" TEXT,
    "prepLink" TEXT,
    "dueMilestone" TEXT,

    CONSTRAINT "WBADefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserWBAProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wbaId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "assessorName" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWBAProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Module" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "institution" TEXT,
    "program" TEXT,
    "name" TEXT NOT NULL,
    "auditPolicy" JSONB,
    "pedagogyConfig" JSONB,
    "sourceAuthorities" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationRationale" (
    "id" TEXT NOT NULL,
    "cardId" TEXT,
    "questionId" TEXT,
    "moduleId" TEXT NOT NULL,
    "whyThisCard" TEXT NOT NULL,
    "connectionTaught" TEXT,
    "soWhat" TEXT,
    "remarkable" BOOLEAN NOT NULL DEFAULT false,
    "conceptTestId" TEXT,
    "variationType" TEXT,
    "sourcePattern" TEXT NOT NULL,
    "generatedBy" TEXT NOT NULL,
    "promptVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationRationale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PedagogicalConceptTest" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "conceptSlug" TEXT NOT NULL,
    "conceptName" TEXT NOT NULL,
    "coreConnection" TEXT NOT NULL,
    "hasBasicTest" BOOLEAN NOT NULL DEFAULT false,
    "hasEdgeCase" BOOLEAN NOT NULL DEFAULT false,
    "hasInverseTest" BOOLEAN NOT NULL DEFAULT false,
    "hasTransferTest" BOOLEAN NOT NULL DEFAULT false,
    "hasNegativeTest" BOOLEAN NOT NULL DEFAULT false,
    "coverageScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "needsEdgeCase" BOOLEAN NOT NULL DEFAULT false,
    "needsInverse" BOOLEAN NOT NULL DEFAULT false,
    "needsTransfer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PedagogicalConceptTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackReasoningLink" (
    "id" TEXT NOT NULL,
    "rationaleId" TEXT NOT NULL,
    "feedbackType" TEXT NOT NULL,
    "feedbackDetail" TEXT,
    "userId" TEXT,
    "retentionRate" DOUBLE PRECISION,
    "avgInterval" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackReasoningLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PedagogicalPattern" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT,
    "patternName" TEXT NOT NULL,
    "totalCards" INTEGER NOT NULL DEFAULT 0,
    "flagRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgRetention" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "struggleRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "skipRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "diagnosis" TEXT,
    "recommendedFix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PedagogicalPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "message" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "path" TEXT,
    "userAgent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentImage" (
    "id" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT,
    "sourceUrl" TEXT,
    "sourceName" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "attribution" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT,
    "description" TEXT,
    "domain" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "anatomyRegion" TEXT,
    "conditions" TEXT[],
    "findings" TEXT[],
    "clinicalContext" TEXT,
    "difficulty" TEXT NOT NULL DEFAULT 'intermediate',
    "rotation" TEXT,
    "topics" TEXT[],
    "usedIn" TEXT[],
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "qualityScore" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnatomyRegion" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cardCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnatomyRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnatomyStructure" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseImage" TEXT NOT NULL,
    "questionOverlay" TEXT NOT NULL,
    "answerOverlay" TEXT NOT NULL,
    "originalId" TEXT NOT NULL,
    "system" TEXT,
    "curricula" TEXT[] DEFAULT ARRAY['bluelink']::TEXT[],
    "clinicalTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnatomyStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnatomyFlashcard" (
    "id" TEXT NOT NULL,
    "structureId" TEXT,
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "region" TEXT,
    "system" TEXT,
    "curricula" TEXT[] DEFAULT ARRAY['bluelink']::TEXT[],
    "clinicalTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "source" TEXT NOT NULL DEFAULT 'bluelink',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnatomyFlashcard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnatomyFlashcardProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flashcardId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "lastSeen" TIMESTAMP(3),
    "nextDue" TIMESTAMP(3),
    "interval" INTEGER NOT NULL DEFAULT 1,
    "easeFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,

    CONSTRAINT "AnatomyFlashcardProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnatomyMCQ" (
    "id" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "structureIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageUrl" TEXT,
    "region" TEXT,
    "system" TEXT,
    "curricula" TEXT[] DEFAULT ARRAY['bluelink']::TEXT[],
    "clinicalTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "source" TEXT NOT NULL DEFAULT 'custom',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnatomyMCQ_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnatomyMCQProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mcqId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "lastSeen" TIMESTAMP(3),
    "nextDue" TIMESTAMP(3),
    "interval" INTEGER NOT NULL DEFAULT 1,
    "easeFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,

    CONSTRAINT "AnatomyMCQProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnatomyProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "structureId" TEXT,
    "cardId" TEXT,
    "retrievalStrength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stabilityDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "nextDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "lastReview" TIMESTAMP(3),
    "lastQuality" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'learning',
    "consecutiveCorrect" INTEGER NOT NULL DEFAULT 0,
    "masteredAt" TIMESTAMP(3),

    CONSTRAINT "AnatomyProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnatomyReviewEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "cardType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "occlusionRegionId" TEXT,
    "quality" INTEGER NOT NULL,
    "responseTimeMs" INTEGER NOT NULL,
    "revealTimeMs" INTEGER,
    "selectedOption" TEXT,
    "wasCorrect" BOOLEAN,
    "positionInSession" INTEGER NOT NULL,
    "sessionDurationMs" INTEGER NOT NULL,
    "recentAccuracy" DOUBLE PRECISION NOT NULL,
    "hourOfDay" INTEGER NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "daysUntilExam" INTEGER,
    "deviceType" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnatomyReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GsseCard" (
    "id" TEXT NOT NULL,
    "stableId" TEXT,
    "cardType" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "bodySystem" TEXT,
    "anatomyRegion" TEXT,
    "moduleNodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "backs" JSONB,
    "options" JSONB,
    "explanation" TEXT,
    "imageUrl" TEXT,
    "questionType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceFile" TEXT,
    "sourceReference" TEXT,
    "originalId" TEXT,
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "highYield" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "hasImage" BOOLEAN NOT NULL DEFAULT false,
    "topics" TEXT[],
    "clusterId" TEXT,
    "similarCards" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GsseCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GsseProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "stabilityDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "nextDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retrievalStrength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "lastReview" TIMESTAMP(3),
    "lastQuality" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'learning',
    "consecutiveCorrect" INTEGER NOT NULL DEFAULT 0,
    "masteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GsseProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GsseSpotImage" (
    "id" TEXT NOT NULL,
    "spotPaperId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "structures" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "attribution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GsseSpotImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GsseCluster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "section" TEXT,
    "cardCount" INTEGER NOT NULL DEFAULT 0,
    "centroidCardId" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GsseCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GsseConceptMastery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "mastery" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgRetrieval" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "coverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cardsReviewed" INTEGER NOT NULL DEFAULT 0,
    "cardsTotal" INTEGER NOT NULL DEFAULT 0,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "lastReviewedAt" TIMESTAMP(3),
    "lastComputedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GsseConceptMastery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsydMd1AnatomyCard" (
    "id" TEXT NOT NULL,
    "stableId" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "week" INTEGER,
    "dissectionLab" TEXT,
    "cardType" TEXT NOT NULL,
    "imageUrl" TEXT,
    "overlayUrl" TEXT,
    "front" TEXT,
    "back" TEXT,
    "stem" TEXT,
    "options" JSONB,
    "answer" TEXT,
    "explanation" TEXT,
    "region" TEXT,
    "system" TEXT,
    "structures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "highYield" BOOLEAN NOT NULL DEFAULT false,
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "source" TEXT NOT NULL DEFAULT 'generated',
    "sourceFile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsydMd1AnatomyCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsydMd1AnatomyProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "stabilityDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "nextDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retrievalStrength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastReview" TIMESTAMP(3),
    "lastQuality" INTEGER,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'learning',
    "consecutiveCorrect" INTEGER NOT NULL DEFAULT 0,
    "masteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsydMd1AnatomyProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicalTerm" (
    "id" TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "aliases" TEXT[],
    "category" TEXT NOT NULL,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "preferredAbbreviation" TEXT,
    "definition" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicalTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardExamRelevance" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "relevance" DOUBLE PRECISION NOT NULL,
    "katSignal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "peerNoteSignal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lectureSignal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "textbookSignal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "nearestSource" TEXT,
    "nearestSimilarity" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardExamRelevance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamDefinition" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "moduleNodes" TEXT[],
    "examDate" TIMESTAMP(3),
    "katWeight" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "peerNoteWeight" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "lectureWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "textbookWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentExposure" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "primaryType" TEXT NOT NULL,
    "primaryId" TEXT NOT NULL,
    "exposedType" TEXT NOT NULL,
    "exposedId" TEXT NOT NULL,
    "exposureReason" TEXT NOT NULL,
    "similarityScore" DOUBLE PRECISION,
    "displayed" BOOLEAN NOT NULL DEFAULT true,
    "engaged" BOOLEAN NOT NULL DEFAULT false,
    "engagementMs" INTEGER,
    "positionInSession" INTEGER,
    "daysUntilExam" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentExposure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionSnapshot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "positionInSession" INTEGER NOT NULL,
    "sessionDurationMs" INTEGER NOT NULL,
    "itemsAttempted" INTEGER NOT NULL,
    "itemsCorrect" INTEGER NOT NULL,
    "recentAccuracy" DOUBLE PRECISION NOT NULL,
    "streakLength" INTEGER NOT NULL,
    "daysUntilExam" INTEGER,
    "examPhase" TEXT,
    "hourOfDay" INTEGER NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "deviceType" TEXT,
    "learningEventId" TEXT,

    CONSTRAINT "SessionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferObservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exposureType" TEXT NOT NULL,
    "exposureId" TEXT NOT NULL,
    "exposureTimestamp" TIMESTAMP(3) NOT NULL,
    "outcomeQuestionId" TEXT NOT NULL,
    "outcomeCorrect" BOOLEAN NOT NULL,
    "outcomeTimestamp" TIMESTAMP(3) NOT NULL,
    "lagSeconds" INTEGER NOT NULL,
    "semanticSimilarity" DOUBLE PRECISION NOT NULL,
    "sharedConcepts" TEXT[],
    "exposureStrength" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBehaviorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "responseTimeMean" DOUBLE PRECISION NOT NULL,
    "responseTimeStd" DOUBLE PRECISION NOT NULL,
    "responseTimeSkew" DOUBLE PRECISION,
    "avgSessionLength" DOUBLE PRECISION NOT NULL,
    "avgSessionItems" DOUBLE PRECISION NOT NULL,
    "sessionsPerWeek" DOUBLE PRECISION NOT NULL,
    "preferredHour" INTEGER,
    "accuracyTrend" DOUBLE PRECISION NOT NULL,
    "masteryVelocity" DOUBLE PRECISION NOT NULL,
    "citationClickRate" DOUBLE PRECISION NOT NULL,
    "explanationReadRate" DOUBLE PRECISION NOT NULL,
    "avgEngagementDepth" DOUBLE PRECISION NOT NULL,
    "responseTimeEntropy" DOUBLE PRECISION NOT NULL,
    "sessionTimeEntropy" DOUBLE PRECISION NOT NULL,
    "behaviorPCAVariance" DOUBLE PRECISION[],
    "anomalyScore" DOUBLE PRECISION,

    CONSTRAINT "UserBehaviorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarvestSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institution" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" "HarvestSessionStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "HarvestSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarvestEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventType" "HarvestEventType" NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "url" TEXT,
    "pageTitle" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detectedInstitution" TEXT,
    "detectedRotation" TEXT,
    "detectedTopics" TEXT[],
    "qualityScore" DOUBLE PRECISION,
    "status" "HarvestEventStatus" NOT NULL DEFAULT 'PENDING',
    "processedAt" TIMESTAMP(3),
    "contentLakeEntryId" TEXT,

    CONSTRAINT "HarvestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCATTopic" (
    "id" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentSlug" TEXT,
    "description" TEXT,
    "contentLakeChunks" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCATTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCATCard" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "difficulty" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MCATCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCATQuestion" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "passage" TEXT,
    "options" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MCATQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCATResponse" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedKey" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "timeSpentMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MCATResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MCATProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "stabilityDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "nextDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retrievalStrength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCATProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATSection" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "GAMSATSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATTopic" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentSlug" TEXT,
    "description" TEXT,
    "contentLakeChunks" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GAMSATTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATCard" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATS1Passage" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "source" TEXT,
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATS1Passage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATS1Question" (
    "id" TEXT NOT NULL,
    "passageId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctKey" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "skillTested" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATS1Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATS1Response" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedKey" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "timeSpentMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATS1Response_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATS2Prompt" (
    "id" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "quotes" JSONB NOT NULL,
    "theme" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATS2Prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATS2Sample" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "essay" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "analysis" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATS2Sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATS3Passage" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "figures" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATS3Passage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATS3Question" (
    "id" TEXT NOT NULL,
    "passageId" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctKey" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "conceptsTested" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATS3Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATS3Response" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedKey" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "timeSpentMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GAMSATS3Response_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GAMSATProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "section" INTEGER NOT NULL,
    "topicSlug" TEXT,
    "stabilityDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "nextDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retrievalStrength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GAMSATProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_FactToSourceCitation" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserEmail_email_key" ON "UserEmail"("email");

-- CreateIndex
CREATE INDEX "UserEmail_userId_idx" ON "UserEmail"("userId");

-- CreateIndex
CREATE INDEX "UserEmail_email_idx" ON "UserEmail"("email");

-- CreateIndex
CREATE INDEX "AnonymousSession_fingerprint_idx" ON "AnonymousSession"("fingerprint");

-- CreateIndex
CREATE INDEX "AnonymousSession_userId_idx" ON "AnonymousSession"("userId");

-- CreateIndex
CREATE INDEX "AgentJob_status_priority_idx" ON "AgentJob"("status", "priority");

-- CreateIndex
CREATE INDEX "AgentJob_type_idx" ON "AgentJob"("type");

-- CreateIndex
CREATE INDEX "AgentJob_rotation_idx" ON "AgentJob"("rotation");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "UserRotation_userId_rotation_key" ON "UserRotation"("userId", "rotation");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleNode_slug_key" ON "ModuleNode"("slug");

-- CreateIndex
CREATE INDEX "ModuleNode_parentSlug_idx" ON "ModuleNode"("parentSlug");

-- CreateIndex
CREATE INDEX "ModuleNode_nodeType_idx" ON "ModuleNode"("nodeType");

-- CreateIndex
CREATE INDEX "UserClusterState_userId_needsAttention_idx" ON "UserClusterState"("userId", "needsAttention");

-- CreateIndex
CREATE INDEX "UserClusterState_clusterId_idx" ON "UserClusterState"("clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "UserClusterState_userId_clusterId_key" ON "UserClusterState"("userId", "clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "Card_stableId_key" ON "Card"("stableId");

-- CreateIndex
CREATE UNIQUE INDEX "Card_embeddingId_key" ON "Card"("embeddingId");

-- CreateIndex
CREATE INDEX "Card_rotation_week_idx" ON "Card"("rotation", "week");

-- CreateIndex
CREATE INDEX "Card_clusterId_idx" ON "Card"("clusterId");

-- CreateIndex
CREATE INDEX "Card_wikiArticleId_idx" ON "Card"("wikiArticleId");

-- CreateIndex
CREATE INDEX "Card_factId_idx" ON "Card"("factId");

-- CreateIndex
CREATE INDEX "Card_conceptId_idx" ON "Card"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "Embedding_cardId_key" ON "Embedding"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "card_embeddings_card_id_key" ON "card_embeddings"("card_id");

-- CreateIndex
CREATE UNIQUE INDEX "question_embeddings_question_id_key" ON "question_embeddings"("question_id");

-- CreateIndex
CREATE UNIQUE INDEX "courseware_embeddings_chunk_id_key" ON "courseware_embeddings"("chunk_id");

-- CreateIndex
CREATE UNIQUE INDEX "concept_subspaces_concept_id_key" ON "concept_subspaces"("concept_id");

-- CreateIndex
CREATE INDEX "CardProgress_userId_nextDueAt_idx" ON "CardProgress"("userId", "nextDueAt");

-- CreateIndex
CREATE INDEX "CardProgress_userId_suppressed_idx" ON "CardProgress"("userId", "suppressed");

-- CreateIndex
CREATE INDEX "CardProgress_userId_flagged_idx" ON "CardProgress"("userId", "flagged");

-- CreateIndex
CREATE INDEX "CardProgress_userId_idx" ON "CardProgress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CardProgress_cardId_userId_key" ON "CardProgress"("cardId", "userId");

-- CreateIndex
CREATE INDEX "TableQuizAttempt_userId_rotation_idx" ON "TableQuizAttempt"("userId", "rotation");

-- CreateIndex
CREATE INDEX "TableQuizAttempt_tableId_idx" ON "TableQuizAttempt"("tableId");

-- CreateIndex
CREATE INDEX "ImageOcclusionAttempt_userId_rotation_idx" ON "ImageOcclusionAttempt"("userId", "rotation");

-- CreateIndex
CREATE INDEX "ImageOcclusionAttempt_imageId_idx" ON "ImageOcclusionAttempt"("imageId");

-- CreateIndex
CREATE INDEX "PageView_userId_rotation_idx" ON "PageView"("userId", "rotation");

-- CreateIndex
CREATE INDEX "PageView_path_idx" ON "PageView"("path");

-- CreateIndex
CREATE INDEX "PageView_viewedAt_idx" ON "PageView"("viewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PageMetadata_path_key" ON "PageMetadata"("path");

-- CreateIndex
CREATE INDEX "PageMetadata_rotation_week_idx" ON "PageMetadata"("rotation", "week");

-- CreateIndex
CREATE INDEX "ContentInteraction_userId_componentType_idx" ON "ContentInteraction"("userId", "componentType");

-- CreateIndex
CREATE INDEX "ContentInteraction_rotation_componentType_idx" ON "ContentInteraction"("rotation", "componentType");

-- CreateIndex
CREATE INDEX "ContentInteraction_timestamp_idx" ON "ContentInteraction"("timestamp");

-- CreateIndex
CREATE INDEX "DailyStats_userId_date_idx" ON "DailyStats"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyStats_userId_date_key" ON "DailyStats"("userId", "date");

-- CreateIndex
CREATE INDEX "CardTypePreference_userId_idx" ON "CardTypePreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CardTypePreference_userId_sourceType_key" ON "CardTypePreference"("userId", "sourceType");

-- CreateIndex
CREATE INDEX "TopicPreference_userId_idx" ON "TopicPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TopicPreference_userId_topic_key" ON "TopicPreference"("userId", "topic");

-- CreateIndex
CREATE INDEX "PulseEntry_userId_date_idx" ON "PulseEntry"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PulseEntry_userId_date_key" ON "PulseEntry"("userId", "date");

-- CreateIndex
CREATE INDEX "DailyPulse_userId_date_idx" ON "DailyPulse"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPulse_userId_date_key" ON "DailyPulse"("userId", "date");

-- CreateIndex
CREATE INDEX "ContentFeedback_targetType_targetId_idx" ON "ContentFeedback"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ContentFeedback_status_idx" ON "ContentFeedback"("status");

-- CreateIndex
CREATE INDEX "ContentFeedback_rotation_idx" ON "ContentFeedback"("rotation");

-- CreateIndex
CREATE INDEX "ContentFeedback_createdAt_idx" ON "ContentFeedback"("createdAt");

-- CreateIndex
CREATE INDEX "ContentIssue_status_idx" ON "ContentIssue"("status");

-- CreateIndex
CREATE INDEX "ContentIssue_targetType_targetId_idx" ON "ContentIssue"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ContentIssue_issueType_idx" ON "ContentIssue"("issueType");

-- CreateIndex
CREATE INDEX "ContentIssue_createdAt_idx" ON "ContentIssue"("createdAt");

-- CreateIndex
CREATE INDEX "ContentIssue_priority_idx" ON "ContentIssue"("priority");

-- CreateIndex
CREATE INDEX "ContentIssue_reportCount_idx" ON "ContentIssue"("reportCount");

-- CreateIndex
CREATE UNIQUE INDEX "ContentIssue_targetType_targetId_issueType_status_key" ON "ContentIssue"("targetType", "targetId", "issueType", "status");

-- CreateIndex
CREATE INDEX "ContentIssueReport_issueId_idx" ON "ContentIssueReport"("issueId");

-- CreateIndex
CREATE INDEX "ContentIssueReport_userId_idx" ON "ContentIssueReport"("userId");

-- CreateIndex
CREATE INDEX "ContentIssueReport_createdAt_idx" ON "ContentIssueReport"("createdAt");

-- CreateIndex
CREATE INDEX "ContentAuditItem_status_idx" ON "ContentAuditItem"("status");

-- CreateIndex
CREATE INDEX "ContentAuditItem_riskTier_idx" ON "ContentAuditItem"("riskTier");

-- CreateIndex
CREATE INDEX "ContentAuditItem_rotation_week_idx" ON "ContentAuditItem"("rotation", "week");

-- CreateIndex
CREATE INDEX "ContentAuditItem_nextAuditAt_idx" ON "ContentAuditItem"("nextAuditAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentAuditItem_targetType_targetId_jurisdiction_key" ON "ContentAuditItem"("targetType", "targetId", "jurisdiction");

-- CreateIndex
CREATE INDEX "ContentAudit_auditItemId_idx" ON "ContentAudit"("auditItemId");

-- CreateIndex
CREATE INDEX "ContentAudit_auditedAt_idx" ON "ContentAudit"("auditedAt");

-- CreateIndex
CREATE INDEX "ContentAudit_jurisdiction_idx" ON "ContentAudit"("jurisdiction");

-- CreateIndex
CREATE INDEX "SourceArtifact_sourceId_idx" ON "SourceArtifact"("sourceId");

-- CreateIndex
CREATE INDEX "SourceArtifact_jurisdiction_artifactType_idx" ON "SourceArtifact"("jurisdiction", "artifactType");

-- CreateIndex
CREATE INDEX "SourceArtifact_checksum_idx" ON "SourceArtifact"("checksum");

-- CreateIndex
CREATE INDEX "Concept_rotation_week_idx" ON "Concept"("rotation", "week");

-- CreateIndex
CREATE INDEX "Concept_topics_idx" ON "Concept"("topics");

-- CreateIndex
CREATE INDEX "ContentGap_rotation_gapType_idx" ON "ContentGap"("rotation", "gapType");

-- CreateIndex
CREATE INDEX "ContentGap_detectedAt_idx" ON "ContentGap"("detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Question_cardId_key" ON "Question"("cardId");

-- CreateIndex
CREATE INDEX "Question_rotation_week_idx" ON "Question"("rotation", "week");

-- CreateIndex
CREATE INDEX "Question_source_idx" ON "Question"("source");

-- CreateIndex
CREATE INDEX "Question_questionType_idx" ON "Question"("questionType");

-- CreateIndex
CREATE INDEX "Question_chainId_idx" ON "Question"("chainId");

-- CreateIndex
CREATE INDEX "Question_variantGroupId_idx" ON "Question"("variantGroupId");

-- CreateIndex
CREATE INDEX "Question_contentState_idx" ON "Question"("contentState");

-- CreateIndex
CREATE INDEX "PipelineRun_questionId_idx" ON "PipelineRun"("questionId");

-- CreateIndex
CREATE INDEX "PipelineRun_stage_model_idx" ON "PipelineRun"("stage", "model");

-- CreateIndex
CREATE INDEX "PipelineRun_success_idx" ON "PipelineRun"("success");

-- CreateIndex
CREATE INDEX "PipelineRun_createdAt_idx" ON "PipelineRun"("createdAt");

-- CreateIndex
CREATE INDEX "QuestionConcept_conceptId_idx" ON "QuestionConcept"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionConcept_questionId_conceptId_key" ON "QuestionConcept"("questionId", "conceptId");

-- CreateIndex
CREATE INDEX "QuestionResponse_userId_questionId_idx" ON "QuestionResponse"("userId", "questionId");

-- CreateIndex
CREATE INDEX "QuestionResponse_userId_createdAt_idx" ON "QuestionResponse"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "QuestionResponse_questionId_isCorrect_idx" ON "QuestionResponse"("questionId", "isCorrect");

-- CreateIndex
CREATE INDEX "CardVersion_cardId_createdAt_idx" ON "CardVersion"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "CardVersion_contentHash_idx" ON "CardVersion"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "CardVersion_cardId_versionNumber_key" ON "CardVersion"("cardId", "versionNumber");

-- CreateIndex
CREATE INDEX "LearningEvent_userId_timestamp_idx" ON "LearningEvent"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "LearningEvent_userId_sourceType_sourceId_idx" ON "LearningEvent"("userId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "LearningEvent_userId_eventType_idx" ON "LearningEvent"("userId", "eventType");

-- CreateIndex
CREATE INDEX "LearningEvent_conceptIds_idx" ON "LearningEvent"("conceptIds");

-- CreateIndex
CREATE INDEX "LearningEvent_auditItemId_idx" ON "LearningEvent"("auditItemId");

-- CreateIndex
CREATE INDEX "LearningEvent_cardVersionId_idx" ON "LearningEvent"("cardVersionId");

-- CreateIndex
CREATE INDEX "ConceptState_userId_recallOnExamDay_idx" ON "ConceptState"("userId", "recallOnExamDay");

-- CreateIndex
CREATE INDEX "ConceptState_userId_confidence_idx" ON "ConceptState"("userId", "confidence");

-- CreateIndex
CREATE INDEX "ConceptState_conceptId_idx" ON "ConceptState"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptState_userId_conceptId_key" ON "ConceptState"("userId", "conceptId");

-- CreateIndex
CREATE INDEX "UserStruggleRegion_userId_idx" ON "UserStruggleRegion"("userId");

-- CreateIndex
CREATE INDEX "UserStruggleRegion_userId_resolvedAt_idx" ON "UserStruggleRegion"("userId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserStruggleRegion_userId_rotation_key" ON "UserStruggleRegion"("userId", "rotation");

-- CreateIndex
CREATE INDEX "StruggleIntervention_userId_rotation_idx" ON "StruggleIntervention"("userId", "rotation");

-- CreateIndex
CREATE INDEX "StruggleIntervention_triggerCardId_idx" ON "StruggleIntervention"("triggerCardId");

-- CreateIndex
CREATE INDEX "StruggleIntervention_strategy_resolved_idx" ON "StruggleIntervention"("strategy", "resolved");

-- CreateIndex
CREATE INDEX "StruggleIntervention_stillFragile_idx" ON "StruggleIntervention"("stillFragile");

-- CreateIndex
CREATE INDEX "TeachingSignal_userId_rotation_idx" ON "TeachingSignal"("userId", "rotation");

-- CreateIndex
CREATE INDEX "TeachingSignal_userId_resolvedAt_idx" ON "TeachingSignal"("userId", "resolvedAt");

-- CreateIndex
CREATE INDEX "TeachingSignal_itemId_idx" ON "TeachingSignal"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "TeachingSnippet_embeddingId_key" ON "TeachingSnippet"("embeddingId");

-- CreateIndex
CREATE INDEX "TeachingSnippet_rotation_week_idx" ON "TeachingSnippet"("rotation", "week");

-- CreateIndex
CREATE INDEX "TeachingSnippet_format_idx" ON "TeachingSnippet"("format");

-- CreateIndex
CREATE INDEX "TeachingSnippet_topics_idx" ON "TeachingSnippet"("topics");

-- CreateIndex
CREATE INDEX "SnippetConcept_conceptId_idx" ON "SnippetConcept"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "SnippetConcept_snippetId_conceptId_key" ON "SnippetConcept"("snippetId", "conceptId");

-- CreateIndex
CREATE INDEX "SkillSession_userId_skillId_idx" ON "SkillSession"("userId", "skillId");

-- CreateIndex
CREATE INDEX "SkillSession_userId_startedAt_idx" ON "SkillSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "SkillSession_skillId_idx" ON "SkillSession"("skillId");

-- CreateIndex
CREATE INDEX "SkillProgress_userId_idx" ON "SkillProgress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillProgress_userId_skillId_key" ON "SkillProgress"("userId", "skillId");

-- CreateIndex
CREATE UNIQUE INDEX "WikiArticle_slug_key" ON "WikiArticle"("slug");

-- CreateIndex
CREATE INDEX "WikiArticle_rotation_week_idx" ON "WikiArticle"("rotation", "week");

-- CreateIndex
CREATE INDEX "WikiArticle_topics_idx" ON "WikiArticle"("topics");

-- CreateIndex
CREATE UNIQUE INDEX "Source_slug_key" ON "Source"("slug");

-- CreateIndex
CREATE INDEX "Source_sourceType_idx" ON "Source"("sourceType");

-- CreateIndex
CREATE INDEX "Source_reliability_idx" ON "Source"("reliability");

-- CreateIndex
CREATE INDEX "SourceCitation_sourceId_idx" ON "SourceCitation"("sourceId");

-- CreateIndex
CREATE INDEX "SourceCitation_stabilityTier_idx" ON "SourceCitation"("stabilityTier");

-- CreateIndex
CREATE INDEX "CardCitation_citationId_idx" ON "CardCitation"("citationId");

-- CreateIndex
CREATE INDEX "CardCitation_addedBy_idx" ON "CardCitation"("addedBy");

-- CreateIndex
CREATE INDEX "CardCitation_isPrimary_idx" ON "CardCitation"("isPrimary");

-- CreateIndex
CREATE UNIQUE INDEX "CardCitation_cardId_citationId_key" ON "CardCitation"("cardId", "citationId");

-- CreateIndex
CREATE INDEX "CitationSnapshot_citationId_idx" ON "CitationSnapshot"("citationId");

-- CreateIndex
CREATE INDEX "CitationSnapshot_contentHash_idx" ON "CitationSnapshot"("contentHash");

-- CreateIndex
CREATE INDEX "CitationSnapshot_createdAt_idx" ON "CitationSnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "CitationAuditLog_snapshotId_idx" ON "CitationAuditLog"("snapshotId");

-- CreateIndex
CREATE INDEX "CitationAuditLog_action_idx" ON "CitationAuditLog"("action");

-- CreateIndex
CREATE INDEX "CitationAuditLog_occurredAt_idx" ON "CitationAuditLog"("occurredAt");

-- CreateIndex
CREATE INDEX "CitationAuditLog_actor_idx" ON "CitationAuditLog"("actor");

-- CreateIndex
CREATE INDEX "CitationCheck_snapshotId_idx" ON "CitationCheck"("snapshotId");

-- CreateIndex
CREATE INDEX "CitationCheck_checkedAt_idx" ON "CitationCheck"("checkedAt");

-- CreateIndex
CREATE INDEX "CitationCheck_contentChanged_idx" ON "CitationCheck"("contentChanged");

-- CreateIndex
CREATE INDEX "GuidelineSource_jurisdiction_idx" ON "GuidelineSource"("jurisdiction");

-- CreateIndex
CREATE INDEX "GuidelineSource_status_idx" ON "GuidelineSource"("status");

-- CreateIndex
CREATE INDEX "GuidelineSource_topics_idx" ON "GuidelineSource"("topics");

-- CreateIndex
CREATE UNIQUE INDEX "GuidelineSource_jurisdiction_docId_key" ON "GuidelineSource"("jurisdiction", "docId");

-- CreateIndex
CREATE UNIQUE INDEX "GuidelineChunk_citationId_key" ON "GuidelineChunk"("citationId");

-- CreateIndex
CREATE INDEX "GuidelineChunk_guidelineId_idx" ON "GuidelineChunk"("guidelineId");

-- CreateIndex
CREATE INDEX "GuidelineChunk_contentHash_idx" ON "GuidelineChunk"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "citation_embeddings_citation_id_key" ON "citation_embeddings"("citation_id");

-- CreateIndex
CREATE INDEX "Fact_rotation_week_idx" ON "Fact"("rotation", "week");

-- CreateIndex
CREATE INDEX "Fact_wikiArticleId_idx" ON "Fact"("wikiArticleId");

-- CreateIndex
CREATE INDEX "Fact_topics_idx" ON "Fact"("topics");

-- CreateIndex
CREATE INDEX "Fact_verified_idx" ON "Fact"("verified");

-- CreateIndex
CREATE INDEX "Fact_flagged_idx" ON "Fact"("flagged");

-- CreateIndex
CREATE INDEX "FactConcept_conceptId_idx" ON "FactConcept"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "FactConcept_factId_conceptId_key" ON "FactConcept"("factId", "conceptId");

-- CreateIndex
CREATE INDEX "QuestionFact_factId_idx" ON "QuestionFact"("factId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionFact_questionId_factId_key" ON "QuestionFact"("questionId", "factId");

-- CreateIndex
CREATE INDEX "ALSSession_userId_createdAt_idx" ON "ALSSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ALSSession_mode_idx" ON "ALSSession"("mode");

-- CreateIndex
CREATE INDEX "ALSSession_scenarioId_idx" ON "ALSSession"("scenarioId");

-- CreateIndex
CREATE INDEX "ALSEvent_sessionId_timestamp_idx" ON "ALSEvent"("sessionId", "timestamp");

-- CreateIndex
CREATE INDEX "ALSScenario_rotation_idx" ON "ALSScenario"("rotation");

-- CreateIndex
CREATE INDEX "ALSScenario_difficulty_idx" ON "ALSScenario"("difficulty");

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryDomain_slug_key" ON "GlossaryDomain"("slug");

-- CreateIndex
CREATE INDEX "GlossaryTerm_domainId_idx" ON "GlossaryTerm"("domainId");

-- CreateIndex
CREATE INDEX "GlossaryTerm_category_idx" ON "GlossaryTerm"("category");

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryTerm_domainId_abbr_key" ON "GlossaryTerm"("domainId", "abbr");

-- CreateIndex
CREATE INDEX "UserTermState_userId_idx" ON "UserTermState"("userId");

-- CreateIndex
CREATE INDEX "UserTermState_sessionId_idx" ON "UserTermState"("sessionId");

-- CreateIndex
CREATE INDEX "UserTermState_termId_idx" ON "UserTermState"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "UserTermState_userId_termId_key" ON "UserTermState"("userId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "UserTermState_sessionId_termId_key" ON "UserTermState"("sessionId", "termId");

-- CreateIndex
CREATE INDEX "TermEvent_userId_termId_idx" ON "TermEvent"("userId", "termId");

-- CreateIndex
CREATE INDEX "TermEvent_termId_eventType_idx" ON "TermEvent"("termId", "eventType");

-- CreateIndex
CREATE INDEX "TermEvent_timestamp_idx" ON "TermEvent"("timestamp");

-- CreateIndex
CREATE INDEX "UserStudyQueue_userId_idx" ON "UserStudyQueue"("userId");

-- CreateIndex
CREATE INDEX "UserStudyQueue_validUntil_idx" ON "UserStudyQueue"("validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "UserStudyQueue_userId_rotation_key" ON "UserStudyQueue"("userId", "rotation");

-- CreateIndex
CREATE INDEX "MCQExposure_userId_questionId_idx" ON "MCQExposure"("userId", "questionId");

-- CreateIndex
CREATE INDEX "MCQExposure_sessionId_questionId_idx" ON "MCQExposure"("sessionId", "questionId");

-- CreateIndex
CREATE INDEX "MCQExposure_questionId_idx" ON "MCQExposure"("questionId");

-- CreateIndex
CREATE INDEX "MCQExposure_path_idx" ON "MCQExposure"("path");

-- CreateIndex
CREATE INDEX "DeepDiveChatSession_userId_deepDiveSlug_idx" ON "DeepDiveChatSession"("userId", "deepDiveSlug");

-- CreateIndex
CREATE INDEX "DeepDiveChatSession_deepDiveSlug_idx" ON "DeepDiveChatSession"("deepDiveSlug");

-- CreateIndex
CREATE UNIQUE INDEX "DeepDiveChatSession_userId_deepDiveSlug_key" ON "DeepDiveChatSession"("userId", "deepDiveSlug");

-- CreateIndex
CREATE INDEX "DeepDiveChatMessage_sessionId_idx" ON "DeepDiveChatMessage"("sessionId");

-- CreateIndex
CREATE INDEX "DeepDiveChatMessage_createdAt_idx" ON "DeepDiveChatMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionGroup_slug_key" ON "QuestionGroup"("slug");

-- CreateIndex
CREATE INDEX "QuestionGroup_type_idx" ON "QuestionGroup"("type");

-- CreateIndex
CREATE INDEX "QuestionGroup_rotation_week_idx" ON "QuestionGroup"("rotation", "week");

-- CreateIndex
CREATE INDEX "QuestionGroup_difficulty_idx" ON "QuestionGroup"("difficulty");

-- CreateIndex
CREATE INDEX "QuestionGroupAttempt_userId_groupId_idx" ON "QuestionGroupAttempt"("userId", "groupId");

-- CreateIndex
CREATE INDEX "QuestionGroupAttempt_userId_createdAt_idx" ON "QuestionGroupAttempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "QuestionGroupAttempt_groupId_idx" ON "QuestionGroupAttempt"("groupId");

-- CreateIndex
CREATE INDEX "WBADefinition_rotation_idx" ON "WBADefinition"("rotation");

-- CreateIndex
CREATE INDEX "UserWBAProgress_userId_idx" ON "UserWBAProgress"("userId");

-- CreateIndex
CREATE INDEX "UserWBAProgress_wbaId_idx" ON "UserWBAProgress"("wbaId");

-- CreateIndex
CREATE UNIQUE INDEX "UserWBAProgress_userId_wbaId_key" ON "UserWBAProgress"("userId", "wbaId");

-- CreateIndex
CREATE UNIQUE INDEX "Module_slug_key" ON "Module"("slug");

-- CreateIndex
CREATE INDEX "Module_domain_idx" ON "Module"("domain");

-- CreateIndex
CREATE INDEX "Module_institution_idx" ON "Module"("institution");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationRationale_cardId_key" ON "GenerationRationale"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationRationale_questionId_key" ON "GenerationRationale"("questionId");

-- CreateIndex
CREATE INDEX "GenerationRationale_moduleId_idx" ON "GenerationRationale"("moduleId");

-- CreateIndex
CREATE INDEX "GenerationRationale_sourcePattern_idx" ON "GenerationRationale"("sourcePattern");

-- CreateIndex
CREATE INDEX "GenerationRationale_conceptTestId_idx" ON "GenerationRationale"("conceptTestId");

-- CreateIndex
CREATE INDEX "PedagogicalConceptTest_moduleId_idx" ON "PedagogicalConceptTest"("moduleId");

-- CreateIndex
CREATE INDEX "PedagogicalConceptTest_coverageScore_idx" ON "PedagogicalConceptTest"("coverageScore");

-- CreateIndex
CREATE UNIQUE INDEX "PedagogicalConceptTest_moduleId_conceptSlug_key" ON "PedagogicalConceptTest"("moduleId", "conceptSlug");

-- CreateIndex
CREATE INDEX "FeedbackReasoningLink_rationaleId_idx" ON "FeedbackReasoningLink"("rationaleId");

-- CreateIndex
CREATE INDEX "FeedbackReasoningLink_feedbackType_idx" ON "FeedbackReasoningLink"("feedbackType");

-- CreateIndex
CREATE INDEX "PedagogicalPattern_status_idx" ON "PedagogicalPattern"("status");

-- CreateIndex
CREATE INDEX "PedagogicalPattern_patternName_idx" ON "PedagogicalPattern"("patternName");

-- CreateIndex
CREATE UNIQUE INDEX "PedagogicalPattern_moduleId_patternName_key" ON "PedagogicalPattern"("moduleId", "patternName");

-- CreateIndex
CREATE INDEX "UserFeedback_status_idx" ON "UserFeedback"("status");

-- CreateIndex
CREATE INDEX "UserFeedback_createdAt_idx" ON "UserFeedback"("createdAt");

-- CreateIndex
CREATE INDEX "UserFeedback_userId_idx" ON "UserFeedback"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentImage_filePath_key" ON "ContentImage"("filePath");

-- CreateIndex
CREATE INDEX "ContentImage_domain_idx" ON "ContentImage"("domain");

-- CreateIndex
CREATE INDEX "ContentImage_modality_idx" ON "ContentImage"("modality");

-- CreateIndex
CREATE INDEX "ContentImage_conditions_idx" ON "ContentImage"("conditions");

-- CreateIndex
CREATE INDEX "ContentImage_rotation_idx" ON "ContentImage"("rotation");

-- CreateIndex
CREATE INDEX "ContentImage_sourceName_idx" ON "ContentImage"("sourceName");

-- CreateIndex
CREATE INDEX "ContentImage_license_idx" ON "ContentImage"("license");

-- CreateIndex
CREATE UNIQUE INDEX "AnatomyRegion_slug_key" ON "AnatomyRegion"("slug");

-- CreateIndex
CREATE INDEX "AnatomyRegion_slug_idx" ON "AnatomyRegion"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "AnatomyStructure_originalId_key" ON "AnatomyStructure"("originalId");

-- CreateIndex
CREATE INDEX "AnatomyStructure_regionId_idx" ON "AnatomyStructure"("regionId");

-- CreateIndex
CREATE INDEX "AnatomyStructure_name_idx" ON "AnatomyStructure"("name");

-- CreateIndex
CREATE INDEX "AnatomyStructure_system_idx" ON "AnatomyStructure"("system");

-- CreateIndex
CREATE INDEX "AnatomyFlashcard_structureId_idx" ON "AnatomyFlashcard"("structureId");

-- CreateIndex
CREATE INDEX "AnatomyFlashcard_region_idx" ON "AnatomyFlashcard"("region");

-- CreateIndex
CREATE INDEX "AnatomyFlashcard_system_idx" ON "AnatomyFlashcard"("system");

-- CreateIndex
CREATE INDEX "AnatomyFlashcardProgress_userId_idx" ON "AnatomyFlashcardProgress"("userId");

-- CreateIndex
CREATE INDEX "AnatomyFlashcardProgress_userId_nextDue_idx" ON "AnatomyFlashcardProgress"("userId", "nextDue");

-- CreateIndex
CREATE UNIQUE INDEX "AnatomyFlashcardProgress_userId_flashcardId_key" ON "AnatomyFlashcardProgress"("userId", "flashcardId");

-- CreateIndex
CREATE INDEX "AnatomyMCQ_region_idx" ON "AnatomyMCQ"("region");

-- CreateIndex
CREATE INDEX "AnatomyMCQ_system_idx" ON "AnatomyMCQ"("system");

-- CreateIndex
CREATE INDEX "AnatomyMCQProgress_userId_idx" ON "AnatomyMCQProgress"("userId");

-- CreateIndex
CREATE INDEX "AnatomyMCQProgress_userId_nextDue_idx" ON "AnatomyMCQProgress"("userId", "nextDue");

-- CreateIndex
CREATE UNIQUE INDEX "AnatomyMCQProgress_userId_mcqId_key" ON "AnatomyMCQProgress"("userId", "mcqId");

-- CreateIndex
CREATE INDEX "AnatomyProgress_userId_idx" ON "AnatomyProgress"("userId");

-- CreateIndex
CREATE INDEX "AnatomyProgress_structureId_idx" ON "AnatomyProgress"("structureId");

-- CreateIndex
CREATE INDEX "AnatomyProgress_cardId_idx" ON "AnatomyProgress"("cardId");

-- CreateIndex
CREATE INDEX "AnatomyProgress_userId_status_idx" ON "AnatomyProgress"("userId", "status");

-- CreateIndex
CREATE INDEX "AnatomyProgress_userId_nextDueAt_idx" ON "AnatomyProgress"("userId", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnatomyProgress_userId_structureId_key" ON "AnatomyProgress"("userId", "structureId");

-- CreateIndex
CREATE UNIQUE INDEX "AnatomyProgress_userId_cardId_key" ON "AnatomyProgress"("userId", "cardId");

-- CreateIndex
CREATE INDEX "AnatomyReviewEvent_userId_timestamp_idx" ON "AnatomyReviewEvent"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "AnatomyReviewEvent_cardId_idx" ON "AnatomyReviewEvent"("cardId");

-- CreateIndex
CREATE INDEX "AnatomyReviewEvent_sessionId_idx" ON "AnatomyReviewEvent"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "GsseCard_stableId_key" ON "GsseCard"("stableId");

-- CreateIndex
CREATE INDEX "GsseCard_section_idx" ON "GsseCard"("section");

-- CreateIndex
CREATE INDEX "GsseCard_bodySystem_idx" ON "GsseCard"("bodySystem");

-- CreateIndex
CREATE INDEX "GsseCard_cardType_idx" ON "GsseCard"("cardType");

-- CreateIndex
CREATE INDEX "GsseCard_source_idx" ON "GsseCard"("source");

-- CreateIndex
CREATE INDEX "GsseCard_stableId_idx" ON "GsseCard"("stableId");

-- CreateIndex
CREATE INDEX "GsseCard_clusterId_idx" ON "GsseCard"("clusterId");

-- CreateIndex
CREATE INDEX "GsseProgress_userId_nextDueAt_idx" ON "GsseProgress"("userId", "nextDueAt");

-- CreateIndex
CREATE INDEX "GsseProgress_cardId_idx" ON "GsseProgress"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "GsseProgress_userId_cardId_key" ON "GsseProgress"("userId", "cardId");

-- CreateIndex
CREATE INDEX "GsseSpotImage_spotPaperId_idx" ON "GsseSpotImage"("spotPaperId");

-- CreateIndex
CREATE INDEX "GsseCluster_section_idx" ON "GsseCluster"("section");

-- CreateIndex
CREATE INDEX "GsseConceptMastery_userId_idx" ON "GsseConceptMastery"("userId");

-- CreateIndex
CREATE INDEX "GsseConceptMastery_userId_mastery_idx" ON "GsseConceptMastery"("userId", "mastery");

-- CreateIndex
CREATE INDEX "GsseConceptMastery_clusterId_idx" ON "GsseConceptMastery"("clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "GsseConceptMastery_userId_clusterId_key" ON "GsseConceptMastery"("userId", "clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "UsydMd1AnatomyCard_stableId_key" ON "UsydMd1AnatomyCard"("stableId");

-- CreateIndex
CREATE INDEX "UsydMd1AnatomyCard_block_idx" ON "UsydMd1AnatomyCard"("block");

-- CreateIndex
CREATE INDEX "UsydMd1AnatomyCard_block_week_idx" ON "UsydMd1AnatomyCard"("block", "week");

-- CreateIndex
CREATE INDEX "UsydMd1AnatomyCard_cardType_idx" ON "UsydMd1AnatomyCard"("cardType");

-- CreateIndex
CREATE INDEX "UsydMd1AnatomyCard_dissectionLab_idx" ON "UsydMd1AnatomyCard"("dissectionLab");

-- CreateIndex
CREATE INDEX "UsydMd1AnatomyProgress_userId_idx" ON "UsydMd1AnatomyProgress"("userId");

-- CreateIndex
CREATE INDEX "UsydMd1AnatomyProgress_userId_nextDueAt_idx" ON "UsydMd1AnatomyProgress"("userId", "nextDueAt");

-- CreateIndex
CREATE INDEX "UsydMd1AnatomyProgress_userId_status_idx" ON "UsydMd1AnatomyProgress"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UsydMd1AnatomyProgress_userId_cardId_key" ON "UsydMd1AnatomyProgress"("userId", "cardId");

-- CreateIndex
CREATE UNIQUE INDEX "MedicalTerm_canonical_key" ON "MedicalTerm"("canonical");

-- CreateIndex
CREATE INDEX "MedicalTerm_category_idx" ON "MedicalTerm"("category");

-- CreateIndex
CREATE INDEX "CardExamRelevance_examId_relevance_idx" ON "CardExamRelevance"("examId", "relevance");

-- CreateIndex
CREATE INDEX "CardExamRelevance_cardId_idx" ON "CardExamRelevance"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "CardExamRelevance_cardId_examId_key" ON "CardExamRelevance"("cardId", "examId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamDefinition_slug_key" ON "ExamDefinition"("slug");

-- CreateIndex
CREATE INDEX "ContentExposure_userId_timestamp_idx" ON "ContentExposure"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "ContentExposure_exposedId_idx" ON "ContentExposure"("exposedId");

-- CreateIndex
CREATE INDEX "ContentExposure_primaryId_idx" ON "ContentExposure"("primaryId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionSnapshot_learningEventId_key" ON "SessionSnapshot"("learningEventId");

-- CreateIndex
CREATE INDEX "SessionSnapshot_userId_timestamp_idx" ON "SessionSnapshot"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "SessionSnapshot_sessionId_idx" ON "SessionSnapshot"("sessionId");

-- CreateIndex
CREATE INDEX "TransferObservation_userId_outcomeTimestamp_idx" ON "TransferObservation"("userId", "outcomeTimestamp");

-- CreateIndex
CREATE INDEX "TransferObservation_exposureType_outcomeCorrect_idx" ON "TransferObservation"("exposureType", "outcomeCorrect");

-- CreateIndex
CREATE INDEX "TransferObservation_semanticSimilarity_idx" ON "TransferObservation"("semanticSimilarity");

-- CreateIndex
CREATE INDEX "UserBehaviorProfile_userId_computedAt_idx" ON "UserBehaviorProfile"("userId", "computedAt");

-- CreateIndex
CREATE INDEX "UserBehaviorProfile_anomalyScore_idx" ON "UserBehaviorProfile"("anomalyScore");

-- CreateIndex
CREATE UNIQUE INDEX "UserBehaviorProfile_userId_periodStart_periodEnd_key" ON "UserBehaviorProfile"("userId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "HarvestSession_userId_startedAt_idx" ON "HarvestSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "HarvestSession_status_idx" ON "HarvestSession"("status");

-- CreateIndex
CREATE INDEX "HarvestEvent_sessionId_idx" ON "HarvestEvent"("sessionId");

-- CreateIndex
CREATE INDEX "HarvestEvent_status_timestamp_idx" ON "HarvestEvent"("status", "timestamp");

-- CreateIndex
CREATE INDEX "HarvestEvent_contentHash_idx" ON "HarvestEvent"("contentHash");

-- CreateIndex
CREATE INDEX "HarvestEvent_qualityScore_idx" ON "HarvestEvent"("qualityScore");

-- CreateIndex
CREATE UNIQUE INDEX "MCATTopic_slug_key" ON "MCATTopic"("slug");

-- CreateIndex
CREATE INDEX "MCATTopic_section_idx" ON "MCATTopic"("section");

-- CreateIndex
CREATE INDEX "MCATTopic_parentSlug_idx" ON "MCATTopic"("parentSlug");

-- CreateIndex
CREATE INDEX "MCATCard_topicId_idx" ON "MCATCard"("topicId");

-- CreateIndex
CREATE INDEX "MCATQuestion_topicId_idx" ON "MCATQuestion"("topicId");

-- CreateIndex
CREATE INDEX "MCATQuestion_difficulty_idx" ON "MCATQuestion"("difficulty");

-- CreateIndex
CREATE INDEX "MCATResponse_userId_questionId_idx" ON "MCATResponse"("userId", "questionId");

-- CreateIndex
CREATE INDEX "MCATResponse_userId_isCorrect_idx" ON "MCATResponse"("userId", "isCorrect");

-- CreateIndex
CREATE INDEX "MCATProgress_userId_nextDueAt_idx" ON "MCATProgress"("userId", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "MCATProgress_userId_topicId_key" ON "MCATProgress"("userId", "topicId");

-- CreateIndex
CREATE UNIQUE INDEX "GAMSATSection_slug_key" ON "GAMSATSection"("slug");

-- CreateIndex
CREATE INDEX "GAMSATSection_number_idx" ON "GAMSATSection"("number");

-- CreateIndex
CREATE UNIQUE INDEX "GAMSATTopic_slug_key" ON "GAMSATTopic"("slug");

-- CreateIndex
CREATE INDEX "GAMSATTopic_sectionId_idx" ON "GAMSATTopic"("sectionId");

-- CreateIndex
CREATE INDEX "GAMSATTopic_parentSlug_idx" ON "GAMSATTopic"("parentSlug");

-- CreateIndex
CREATE INDEX "GAMSATCard_topicId_idx" ON "GAMSATCard"("topicId");

-- CreateIndex
CREATE INDEX "GAMSATS1Passage_type_idx" ON "GAMSATS1Passage"("type");

-- CreateIndex
CREATE INDEX "GAMSATS1Question_passageId_idx" ON "GAMSATS1Question"("passageId");

-- CreateIndex
CREATE INDEX "GAMSATS1Question_skillTested_idx" ON "GAMSATS1Question"("skillTested");

-- CreateIndex
CREATE INDEX "GAMSATS1Response_userId_questionId_idx" ON "GAMSATS1Response"("userId", "questionId");

-- CreateIndex
CREATE INDEX "GAMSATS1Response_userId_isCorrect_idx" ON "GAMSATS1Response"("userId", "isCorrect");

-- CreateIndex
CREATE INDEX "GAMSATS2Prompt_taskType_idx" ON "GAMSATS2Prompt"("taskType");

-- CreateIndex
CREATE INDEX "GAMSATS2Sample_promptId_idx" ON "GAMSATS2Sample"("promptId");

-- CreateIndex
CREATE INDEX "GAMSATS2Sample_score_idx" ON "GAMSATS2Sample"("score");

-- CreateIndex
CREATE INDEX "GAMSATS3Passage_topic_idx" ON "GAMSATS3Passage"("topic");

-- CreateIndex
CREATE INDEX "GAMSATS3Question_passageId_idx" ON "GAMSATS3Question"("passageId");

-- CreateIndex
CREATE INDEX "GAMSATS3Response_userId_questionId_idx" ON "GAMSATS3Response"("userId", "questionId");

-- CreateIndex
CREATE INDEX "GAMSATS3Response_userId_isCorrect_idx" ON "GAMSATS3Response"("userId", "isCorrect");

-- CreateIndex
CREATE INDEX "GAMSATProgress_userId_nextDueAt_idx" ON "GAMSATProgress"("userId", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "GAMSATProgress_userId_section_topicSlug_key" ON "GAMSATProgress"("userId", "section", "topicSlug");

-- CreateIndex
CREATE UNIQUE INDEX "_FactToSourceCitation_AB_unique" ON "_FactToSourceCitation"("A", "B");

-- CreateIndex
CREATE INDEX "_FactToSourceCitation_B_index" ON "_FactToSourceCitation"("B");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmail" ADD CONSTRAINT "UserEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnonymousSession" ADD CONSTRAINT "AnonymousSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRotation" ADD CONSTRAINT "UserRotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClusterState" ADD CONSTRAINT "UserClusterState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClusterState" ADD CONSTRAINT "UserClusterState_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_wikiArticleId_fkey" FOREIGN KEY ("wikiArticleId") REFERENCES "WikiArticle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_factId_fkey" FOREIGN KEY ("factId") REFERENCES "Fact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardProgress" ADD CONSTRAINT "CardProgress_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardProgress" ADD CONSTRAINT "CardProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageView" ADD CONSTRAINT "PageView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentInteraction" ADD CONSTRAINT "ContentInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPulse" ADD CONSTRAINT "DailyPulse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIssueReport" ADD CONSTRAINT "ContentIssueReport_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "ContentIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIssueReport" ADD CONSTRAINT "ContentIssueReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAudit" ADD CONSTRAINT "ContentAudit_auditItemId_fkey" FOREIGN KEY ("auditItemId") REFERENCES "ContentAuditItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceArtifact" ADD CONSTRAINT "SourceArtifact_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentGap" ADD CONSTRAINT "ContentGap_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineRun" ADD CONSTRAINT "PipelineRun_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionConcept" ADD CONSTRAINT "QuestionConcept_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionConcept" ADD CONSTRAINT "QuestionConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionResponse" ADD CONSTRAINT "QuestionResponse_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionResponse" ADD CONSTRAINT "QuestionResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardVersion" ADD CONSTRAINT "CardVersion_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_cardVersionId_fkey" FOREIGN KEY ("cardVersionId") REFERENCES "CardVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptState" ADD CONSTRAINT "ConceptState_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnippetConcept" ADD CONSTRAINT "SnippetConcept_snippetId_fkey" FOREIGN KEY ("snippetId") REFERENCES "TeachingSnippet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnippetConcept" ADD CONSTRAINT "SnippetConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillSession" ADD CONSTRAINT "SkillSession_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillProgress" ADD CONSTRAINT "SkillProgress_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceCitation" ADD CONSTRAINT "SourceCitation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardCitation" ADD CONSTRAINT "CardCitation_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardCitation" ADD CONSTRAINT "CardCitation_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "SourceCitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationSnapshot" ADD CONSTRAINT "CitationSnapshot_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "SourceCitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationAuditLog" ADD CONSTRAINT "CitationAuditLog_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CitationSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidelineSource" ADD CONSTRAINT "GuidelineSource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidelineChunk" ADD CONSTRAINT "GuidelineChunk_guidelineId_fkey" FOREIGN KEY ("guidelineId") REFERENCES "GuidelineSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidelineChunk" ADD CONSTRAINT "GuidelineChunk_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "SourceCitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fact" ADD CONSTRAINT "Fact_wikiArticleId_fkey" FOREIGN KEY ("wikiArticleId") REFERENCES "WikiArticle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactConcept" ADD CONSTRAINT "FactConcept_factId_fkey" FOREIGN KEY ("factId") REFERENCES "Fact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactConcept" ADD CONSTRAINT "FactConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionFact" ADD CONSTRAINT "QuestionFact_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionFact" ADD CONSTRAINT "QuestionFact_factId_fkey" FOREIGN KEY ("factId") REFERENCES "Fact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ALSSession" ADD CONSTRAINT "ALSSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ALSSession" ADD CONSTRAINT "ALSSession_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "ALSScenario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ALSEvent" ADD CONSTRAINT "ALSEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ALSSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlossaryTerm" ADD CONSTRAINT "GlossaryTerm_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "GlossaryDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTermState" ADD CONSTRAINT "UserTermState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTermState" ADD CONSTRAINT "UserTermState_termId_fkey" FOREIGN KEY ("termId") REFERENCES "GlossaryTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeepDiveChatSession" ADD CONSTRAINT "DeepDiveChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeepDiveChatMessage" ADD CONSTRAINT "DeepDiveChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DeepDiveChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionGroupAttempt" ADD CONSTRAINT "QuestionGroupAttempt_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "QuestionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWBAProgress" ADD CONSTRAINT "UserWBAProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWBAProgress" ADD CONSTRAINT "UserWBAProgress_wbaId_fkey" FOREIGN KEY ("wbaId") REFERENCES "WBADefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRationale" ADD CONSTRAINT "GenerationRationale_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRationale" ADD CONSTRAINT "GenerationRationale_conceptTestId_fkey" FOREIGN KEY ("conceptTestId") REFERENCES "PedagogicalConceptTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PedagogicalConceptTest" ADD CONSTRAINT "PedagogicalConceptTest_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackReasoningLink" ADD CONSTRAINT "FeedbackReasoningLink_rationaleId_fkey" FOREIGN KEY ("rationaleId") REFERENCES "GenerationRationale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PedagogicalPattern" ADD CONSTRAINT "PedagogicalPattern_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnatomyStructure" ADD CONSTRAINT "AnatomyStructure_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "AnatomyRegion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnatomyFlashcard" ADD CONSTRAINT "AnatomyFlashcard_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "AnatomyStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnatomyFlashcardProgress" ADD CONSTRAINT "AnatomyFlashcardProgress_flashcardId_fkey" FOREIGN KEY ("flashcardId") REFERENCES "AnatomyFlashcard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnatomyMCQProgress" ADD CONSTRAINT "AnatomyMCQProgress_mcqId_fkey" FOREIGN KEY ("mcqId") REFERENCES "AnatomyMCQ"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnatomyProgress" ADD CONSTRAINT "AnatomyProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnatomyProgress" ADD CONSTRAINT "AnatomyProgress_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "AnatomyStructure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnatomyReviewEvent" ADD CONSTRAINT "AnatomyReviewEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GsseProgress" ADD CONSTRAINT "GsseProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GsseProgress" ADD CONSTRAINT "GsseProgress_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "GsseCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GsseConceptMastery" ADD CONSTRAINT "GsseConceptMastery_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "GsseCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsydMd1AnatomyProgress" ADD CONSTRAINT "UsydMd1AnatomyProgress_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "UsydMd1AnatomyCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentExposure" ADD CONSTRAINT "ContentExposure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSnapshot" ADD CONSTRAINT "SessionSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferObservation" ADD CONSTRAINT "TransferObservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBehaviorProfile" ADD CONSTRAINT "UserBehaviorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarvestSession" ADD CONSTRAINT "HarvestSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarvestEvent" ADD CONSTRAINT "HarvestEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "HarvestSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCATCard" ADD CONSTRAINT "MCATCard_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "MCATTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCATQuestion" ADD CONSTRAINT "MCATQuestion_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "MCATTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCATResponse" ADD CONSTRAINT "MCATResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCATResponse" ADD CONSTRAINT "MCATResponse_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "MCATQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCATProgress" ADD CONSTRAINT "MCATProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCATProgress" ADD CONSTRAINT "MCATProgress_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "MCATTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATTopic" ADD CONSTRAINT "GAMSATTopic_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "GAMSATSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATCard" ADD CONSTRAINT "GAMSATCard_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "GAMSATTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATS1Question" ADD CONSTRAINT "GAMSATS1Question_passageId_fkey" FOREIGN KEY ("passageId") REFERENCES "GAMSATS1Passage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATS1Response" ADD CONSTRAINT "GAMSATS1Response_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATS1Response" ADD CONSTRAINT "GAMSATS1Response_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "GAMSATS1Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATS2Sample" ADD CONSTRAINT "GAMSATS2Sample_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "GAMSATS2Prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATS3Question" ADD CONSTRAINT "GAMSATS3Question_passageId_fkey" FOREIGN KEY ("passageId") REFERENCES "GAMSATS3Passage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATS3Response" ADD CONSTRAINT "GAMSATS3Response_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATS3Response" ADD CONSTRAINT "GAMSATS3Response_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "GAMSATS3Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GAMSATProgress" ADD CONSTRAINT "GAMSATProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_FactToSourceCitation" ADD CONSTRAINT "_FactToSourceCitation_A_fkey" FOREIGN KEY ("A") REFERENCES "Fact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_FactToSourceCitation" ADD CONSTRAINT "_FactToSourceCitation_B_fkey" FOREIGN KEY ("B") REFERENCES "SourceCitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
