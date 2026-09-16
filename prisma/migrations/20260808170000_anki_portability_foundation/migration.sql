-- Phase 0 storage and identity contract for lossless Anki portability.
-- This is the single deployable Anki custody layer. The earlier operator-only
-- archive schema is retained as non-deployable reference material.

CREATE TYPE "SchedulerAuthority" AS ENUM ('cohort', 'anki');
CREATE TYPE "ImportEpochStatus" AS ENUM ('staging', 'validated', 'active', 'superseded', 'failed', 'cancelled');
CREATE TYPE "LearningEventOrigin" AS ENUM ('cohort_web', 'cohort_offline', 'anki_import', 'anki_bridge');
CREATE TYPE "LearningMemoryDisposition" AS ENUM ('applied', 'baseline_covered', 'history_only');

CREATE TABLE "AnkiCollection" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "lineageId" TEXT NOT NULL,
    "sourcePackageHash" TEXT,
    "packageFormat" TEXT,
    "formatVersion" TEXT,
    "schemaVersion" TEXT,
    "collectionCreatedAt" TIMESTAMPTZ(3),
    "timezone" TEXT,
    "dayBoundaryMinutes" INTEGER,
    "configurationState" JSONB,
    "status" TEXT NOT NULL DEFAULT 'quarantined',
    "suggestedSchedulerAuthority" "SchedulerAuthority",
    "rawSnapshotObjectKey" TEXT,
    "parseManifest" JSONB,
    "lastConfirmedSnapshotHash" TEXT,
    "lastConfirmedExternalCursor" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "AnkiCollection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiCollection_raw_snapshot_key_check" CHECK (
        "rawSnapshotObjectKey" IS NULL OR (
            "ownerUserId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
            AND "id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
            AND
            left(
                "rawSnapshotObjectKey",
                length('anki-imports/raw/' || "ownerUserId" || '/' || "id" || '/')
            ) = 'anki-imports/raw/' || "ownerUserId" || '/' || "id" || '/'
            AND substring(
                "rawSnapshotObjectKey"
                FROM length('anki-imports/raw/' || "ownerUserId" || '/' || "id" || '/') + 1
            ) ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.apkg$'
        )
    )
);

CREATE TABLE "StudyDeck" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "portableDeckId" TEXT NOT NULL,
    "parentDeckId" TEXT,
    "displayName" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "rightsMetadata" JSONB,
    "source" TEXT NOT NULL,
    "rotation" TEXT,
    "schedulerAuthority" "SchedulerAuthority" NOT NULL DEFAULT 'cohort',
    "sourceCollectionId" TEXT,
    "activeEpochId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "StudyDeck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StudyNoteType" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "portableNoteTypeId" TEXT NOT NULL,
    "sourceCollectionId" TEXT,
    "name" TEXT NOT NULL,
    "fieldDefinitions" JSONB NOT NULL,
    "templates" JSONB NOT NULL,
    "css" TEXT,
    "rendererCapability" TEXT NOT NULL DEFAULT 'preserved_only',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "StudyNoteType_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StudyNote" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "portableNoteId" TEXT NOT NULL,
    "noteTypeId" TEXT NOT NULL,
    "sourceCollectionId" TEXT,
    "fields" JSONB NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sortField" TEXT,
    "revision" TEXT NOT NULL DEFAULT '0',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "StudyNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportEpoch" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "studyDeckId" TEXT NOT NULL,
    "sourceCollectionId" TEXT,
    "status" "ImportEpochStatus" NOT NULL DEFAULT 'staging',
    "sourcePackageHash" TEXT,
    "sourceCursor" TEXT,
    "projectionMode" TEXT,
    "expectedCounts" JSONB,
    "materializedCounts" JSONB,
    "fidelityReport" JSONB,
    "validationError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "validatedAt" TIMESTAMPTZ(3),
    "activatedAt" TIMESTAMPTZ(3),
    "supersededAt" TIMESTAMPTZ(3),
    CONSTRAINT "ImportEpoch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnkiObject" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "revision" TEXT NOT NULL DEFAULT '0',
    "parentExternalId" TEXT,
    "noteGuid" TEXT,
    "checksum" TEXT,
    "contentHash" TEXT NOT NULL,
    "decoderVersion" INTEGER NOT NULL DEFAULT 1,
    "rawPayload" JSONB NOT NULL,
    "isTombstone" BOOLEAN NOT NULL DEFAULT false,
    "mappedStudyDeckId" TEXT,
    "mappedStudyNoteTypeId" TEXT,
    "mappedStudyNoteId" TEXT,
    "mappedCardId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnkiObject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnkiCustodyReview" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "revlogId" TEXT NOT NULL,
    "externalCardId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "ease" INTEGER NOT NULL,
    "ivl" INTEGER NOT NULL,
    "lastIvl" INTEGER NOT NULL,
    "factor" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "reviewType" INTEGER NOT NULL,
    "updateSequence" INTEGER,
    "rawPayload" JSONB NOT NULL,
    "mappedCardId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnkiCustodyReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnkiMedia" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "collisionKey" TEXT NOT NULL,
    "packageIndex" INTEGER,
    "sizeBytes" BIGINT NOT NULL,
    "sniffedMimeType" TEXT,
    "sha1" TEXT,
    "sha256" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "collisionStatus" TEXT NOT NULL DEFAULT 'clear',
    "quarantineStatus" TEXT NOT NULL DEFAULT 'quarantined',
    "renderEligible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AnkiMedia_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiMedia_private_object_key_check" CHECK (
        "ownerUserId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
        AND "collectionId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
        AND "objectKey" = 'anki-imports/media/' || "ownerUserId" || '/' || "collectionId" || '/' || "sha256"
        AND "sha256" ~ '^[a-f0-9]{64}$'
    )
);

-- Existing tables use nullable additions or expand-safe defaults so the old
-- application client can continue writing during the migration/deploy window.
ALTER TABLE "Card"
    ADD COLUMN "ownerUserId" TEXT,
    ADD COLUMN "studyDeckId" TEXT,
    ADD COLUMN "studyNoteId" TEXT,
    ADD COLUMN "importEpochId" TEXT,
    ADD COLUMN "templateOrdinal" INTEGER,
    ADD COLUMN "portableCardId" TEXT;

-- PostgreSQL skips a composite FK when any referencing column is NULL. Without
-- this check, a Card could name a private deck/note/epoch while leaving
-- ownerUserId NULL and be mistaken for shared catalog content.
ALTER TABLE "Card" ADD CONSTRAINT "Card_private_reference_owner_check"
    CHECK (
        ("studyDeckId" IS NULL OR "ownerUserId" IS NOT NULL)
        AND ("studyNoteId" IS NULL OR "ownerUserId" IS NOT NULL)
        AND (
            "importEpochId" IS NULL
            OR ("ownerUserId" IS NOT NULL AND "studyDeckId" IS NOT NULL)
        )
    );

ALTER TABLE "LearningEvent"
    ADD COLUMN "origin" "LearningEventOrigin" NOT NULL DEFAULT 'cohort_web',
    ADD COLUMN "externalCollectionId" TEXT,
    ADD COLUMN "externalEventId" TEXT,
    ADD COLUMN "reviewKind" TEXT,
    ADD COLUMN "ankiCustodyReviewId" TEXT,
    ADD COLUMN "projectorVersion" INTEGER,
    ADD COLUMN "projectorMetadata" JSONB,
    ADD COLUMN "memoryDisposition" "LearningMemoryDisposition",
    ADD COLUMN "memorySequence" INTEGER;

UPDATE "LearningEvent"
SET "origin" = 'cohort_offline'
WHERE "writeTransport" = 'mobile_sync';

ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_memory_application_check"
    CHECK (
        ("memoryDisposition" IS NULL AND "memorySequence" IS NULL)
        OR ("memoryDisposition" = 'applied' AND "memorySequence" > 0)
        OR ("memoryDisposition" IN ('baseline_covered', 'history_only') AND "memorySequence" IS NULL)
    );

ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_external_identity_pair_check"
    CHECK (("externalCollectionId" IS NULL) = ("externalEventId" IS NULL));

ALTER TABLE "CardProgress"
    ADD COLUMN "projectionVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "projectionOrigin" TEXT NOT NULL DEFAULT 'legacy_snapshot',
    ADD COLUMN "projectedThroughEventId" TEXT,
    ADD COLUMN "projectedAt" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "AnkiCollection_id_ownerUserId_key" ON "AnkiCollection"("id", "ownerUserId");
CREATE UNIQUE INDEX "AnkiCollection_ownerUserId_lineageId_key" ON "AnkiCollection"("ownerUserId", "lineageId");
CREATE INDEX "AnkiCollection_ownerUserId_status_idx" ON "AnkiCollection"("ownerUserId", "status");
CREATE INDEX "AnkiCollection_ownerUserId_sourcePackageHash_idx" ON "AnkiCollection"("ownerUserId", "sourcePackageHash");
CREATE INDEX "AnkiCollection_deletedAt_idx" ON "AnkiCollection"("deletedAt");

CREATE UNIQUE INDEX "StudyDeck_portableDeckId_key" ON "StudyDeck"("portableDeckId");
CREATE UNIQUE INDEX "StudyDeck_activeEpochId_key" ON "StudyDeck"("activeEpochId");
CREATE UNIQUE INDEX "StudyDeck_id_ownerUserId_key" ON "StudyDeck"("id", "ownerUserId");
CREATE UNIQUE INDEX "StudyDeck_id_ownerUserId_sourceCollectionId_key" ON "StudyDeck"("id", "ownerUserId", "sourceCollectionId");
CREATE UNIQUE INDEX "StudyDeck_activeEpochId_id_key" ON "StudyDeck"("activeEpochId", "id");
CREATE INDEX "StudyDeck_ownerUserId_visibility_idx" ON "StudyDeck"("ownerUserId", "visibility");
CREATE INDEX "StudyDeck_ownerUserId_parentDeckId_idx" ON "StudyDeck"("ownerUserId", "parentDeckId");
CREATE INDEX "StudyDeck_sourceCollectionId_idx" ON "StudyDeck"("sourceCollectionId");
CREATE INDEX "StudyDeck_deletedAt_idx" ON "StudyDeck"("deletedAt");

CREATE UNIQUE INDEX "StudyNoteType_portableNoteTypeId_key" ON "StudyNoteType"("portableNoteTypeId");
CREATE UNIQUE INDEX "StudyNoteType_id_ownerUserId_key" ON "StudyNoteType"("id", "ownerUserId");
CREATE UNIQUE INDEX "StudyNoteType_id_ownerUserId_sourceCollectionId_key" ON "StudyNoteType"("id", "ownerUserId", "sourceCollectionId");
CREATE INDEX "StudyNoteType_ownerUserId_name_idx" ON "StudyNoteType"("ownerUserId", "name");
CREATE INDEX "StudyNoteType_sourceCollectionId_idx" ON "StudyNoteType"("sourceCollectionId");
CREATE INDEX "StudyNoteType_deletedAt_idx" ON "StudyNoteType"("deletedAt");

CREATE UNIQUE INDEX "StudyNote_portableNoteId_key" ON "StudyNote"("portableNoteId");
CREATE UNIQUE INDEX "StudyNote_id_ownerUserId_key" ON "StudyNote"("id", "ownerUserId");
CREATE UNIQUE INDEX "StudyNote_id_ownerUserId_sourceCollectionId_key" ON "StudyNote"("id", "ownerUserId", "sourceCollectionId");
CREATE INDEX "StudyNote_ownerUserId_noteTypeId_idx" ON "StudyNote"("ownerUserId", "noteTypeId");
CREATE INDEX "StudyNote_sourceCollectionId_idx" ON "StudyNote"("sourceCollectionId");
CREATE INDEX "StudyNote_tags_idx" ON "StudyNote" USING GIN ("tags");
CREATE INDEX "StudyNote_deletedAt_idx" ON "StudyNote"("deletedAt");

CREATE UNIQUE INDEX "ImportEpoch_id_ownerUserId_key" ON "ImportEpoch"("id", "ownerUserId");
CREATE UNIQUE INDEX "ImportEpoch_id_studyDeckId_key" ON "ImportEpoch"("id", "studyDeckId");
CREATE UNIQUE INDEX "ImportEpoch_one_active_per_deck_key" ON "ImportEpoch"("studyDeckId") WHERE "status" = 'active';
CREATE INDEX "ImportEpoch_ownerUserId_status_idx" ON "ImportEpoch"("ownerUserId", "status");
CREATE INDEX "ImportEpoch_studyDeckId_status_idx" ON "ImportEpoch"("studyDeckId", "status");
CREATE INDEX "ImportEpoch_sourceCollectionId_idx" ON "ImportEpoch"("sourceCollectionId");
CREATE INDEX "ImportEpoch_sourcePackageHash_idx" ON "ImportEpoch"("sourcePackageHash");

CREATE UNIQUE INDEX "AnkiObject_collectionId_kind_externalId_revision_key" ON "AnkiObject"("collectionId", "kind", "externalId", "revision");
CREATE INDEX "AnkiObject_ownerUserId_kind_idx" ON "AnkiObject"("ownerUserId", "kind");
CREATE INDEX "AnkiObject_collectionId_noteGuid_idx" ON "AnkiObject"("collectionId", "noteGuid");
CREATE INDEX "AnkiObject_collectionId_parentExternalId_idx" ON "AnkiObject"("collectionId", "parentExternalId");
CREATE INDEX "AnkiObject_collectionId_contentHash_idx" ON "AnkiObject"("collectionId", "contentHash");
CREATE INDEX "AnkiObject_mappedStudyDeckId_idx" ON "AnkiObject"("mappedStudyDeckId");
CREATE INDEX "AnkiObject_mappedStudyNoteTypeId_idx" ON "AnkiObject"("mappedStudyNoteTypeId");
CREATE INDEX "AnkiObject_mappedStudyNoteId_idx" ON "AnkiObject"("mappedStudyNoteId");
CREATE INDEX "AnkiObject_mappedCardId_idx" ON "AnkiObject"("mappedCardId");

CREATE UNIQUE INDEX "AnkiCustodyReview_id_ownerUserId_key" ON "AnkiCustodyReview"("id", "ownerUserId");
CREATE UNIQUE INDEX "AnkiCustodyReview_collectionId_revlogId_key" ON "AnkiCustodyReview"("collectionId", "revlogId");
CREATE INDEX "AnkiCustodyReview_ownerUserId_occurredAt_idx" ON "AnkiCustodyReview"("ownerUserId", "occurredAt");
CREATE INDEX "AnkiCustodyReview_collectionId_externalCardId_occurredAt_idx" ON "AnkiCustodyReview"("collectionId", "externalCardId", "occurredAt");
CREATE INDEX "AnkiCustodyReview_mappedCardId_idx" ON "AnkiCustodyReview"("mappedCardId");

CREATE UNIQUE INDEX "AnkiMedia_collectionId_originalFilename_sha256_key" ON "AnkiMedia"("collectionId", "originalFilename", "sha256");
CREATE INDEX "AnkiMedia_ownerUserId_quarantineStatus_idx" ON "AnkiMedia"("ownerUserId", "quarantineStatus");
CREATE INDEX "AnkiMedia_collectionId_collisionKey_idx" ON "AnkiMedia"("collectionId", "collisionKey");
CREATE INDEX "AnkiMedia_collectionId_packageIndex_idx" ON "AnkiMedia"("collectionId", "packageIndex");
CREATE INDEX "AnkiMedia_sha256_idx" ON "AnkiMedia"("sha256");

CREATE UNIQUE INDEX "Card_portableCardId_key" ON "Card"("portableCardId");
CREATE UNIQUE INDEX "Card_id_ownerUserId_key" ON "Card"("id", "ownerUserId");
CREATE INDEX "Card_ownerUserId_deletedAt_idx" ON "Card"("ownerUserId", "deletedAt");
CREATE INDEX "Card_studyDeckId_importEpochId_idx" ON "Card"("studyDeckId", "importEpochId");
CREATE INDEX "Card_studyNoteId_idx" ON "Card"("studyNoteId");
CREATE INDEX "Card_importEpochId_idx" ON "Card"("importEpochId");

CREATE UNIQUE INDEX "LearningEvent_ankiCustodyReviewId_key" ON "LearningEvent"("ankiCustodyReviewId");
CREATE UNIQUE INDEX "LearningEvent_userId_externalCollectionId_externalEventId_key" ON "LearningEvent"("userId", "externalCollectionId", "externalEventId");
CREATE UNIQUE INDEX "LearningEvent_userId_sourceType_sourceId_memorySequence_key" ON "LearningEvent"("userId", "sourceType", "sourceId", "memorySequence");
CREATE UNIQUE INDEX "LearningEvent_ankiCustodyReviewId_userId_key" ON "LearningEvent"("ankiCustodyReviewId", "userId");
CREATE INDEX "LearningEvent_externalCollectionId_externalEventId_idx" ON "LearningEvent"("externalCollectionId", "externalEventId");
CREATE INDEX "LearningEvent_userId_memoryDisposition_timestamp_idx" ON "LearningEvent"("userId", "memoryDisposition", "timestamp");

CREATE INDEX "CardProgress_projectedThroughEventId_idx" ON "CardProgress"("projectedThroughEventId");

ALTER TABLE "AnkiCollection" ADD CONSTRAINT "AnkiCollection_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "StudyDeck" ADD CONSTRAINT "StudyDeck_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "StudyDeck" ADD CONSTRAINT "StudyDeck_parentDeckId_ownerUserId_fkey"
    FOREIGN KEY ("parentDeckId", "ownerUserId") REFERENCES "StudyDeck"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "StudyDeck" ADD CONSTRAINT "StudyDeck_sourceCollectionId_ownerUserId_fkey"
    FOREIGN KEY ("sourceCollectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "StudyDeck" ADD CONSTRAINT "StudyDeck_activeEpochId_id_fkey"
    FOREIGN KEY ("activeEpochId", "id") REFERENCES "ImportEpoch"("id", "studyDeckId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "StudyNoteType" ADD CONSTRAINT "StudyNoteType_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "StudyNoteType" ADD CONSTRAINT "StudyNoteType_sourceCollectionId_ownerUserId_fkey"
    FOREIGN KEY ("sourceCollectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "StudyNote" ADD CONSTRAINT "StudyNote_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "StudyNote" ADD CONSTRAINT "StudyNote_noteTypeId_ownerUserId_fkey"
    FOREIGN KEY ("noteTypeId", "ownerUserId") REFERENCES "StudyNoteType"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "StudyNote" ADD CONSTRAINT "StudyNote_sourceCollectionId_ownerUserId_fkey"
    FOREIGN KEY ("sourceCollectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "ImportEpoch" ADD CONSTRAINT "ImportEpoch_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ImportEpoch" ADD CONSTRAINT "ImportEpoch_studyDeckId_ownerUserId_fkey"
    FOREIGN KEY ("studyDeckId", "ownerUserId") REFERENCES "StudyDeck"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ImportEpoch" ADD CONSTRAINT "ImportEpoch_sourceCollectionId_ownerUserId_fkey"
    FOREIGN KEY ("sourceCollectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Owner, lineage, portable identity, and raw custody are write-once. Foreign
-- keys also use ON UPDATE RESTRICT, so changing a User id or parent identity
-- cannot silently transfer private study data to another custody namespace.
CREATE FUNCTION "reject_anki_identity_update"() RETURNS TRIGGER AS $$
DECLARE
    immutable_column TEXT;
BEGIN
    FOREACH immutable_column IN ARRAY TG_ARGV LOOP
        IF to_jsonb(OLD) -> immutable_column IS DISTINCT FROM to_jsonb(NEW) -> immutable_column THEN
            RAISE EXCEPTION '% %.% is immutable', TG_TABLE_NAME, immutable_column, OLD."id"
                USING ERRCODE = '23514';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AnkiCollection_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "lineageId" ON "AnkiCollection"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"('id', 'ownerUserId', 'lineageId');

CREATE TRIGGER "StudyDeck_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "portableDeckId", "sourceCollectionId" ON "StudyDeck"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"('id', 'ownerUserId', 'portableDeckId', 'sourceCollectionId');

CREATE TRIGGER "StudyNoteType_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "portableNoteTypeId", "sourceCollectionId" ON "StudyNoteType"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"('id', 'ownerUserId', 'portableNoteTypeId', 'sourceCollectionId');

CREATE TRIGGER "StudyNote_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "portableNoteId", "noteTypeId", "sourceCollectionId" ON "StudyNote"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"('id', 'ownerUserId', 'portableNoteId', 'noteTypeId', 'sourceCollectionId');

CREATE TRIGGER "ImportEpoch_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "studyDeckId", "sourceCollectionId", "sourcePackageHash" ON "ImportEpoch"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"('id', 'ownerUserId', 'studyDeckId', 'sourceCollectionId', 'sourcePackageHash');

-- Every normalized edge must remain inside the same source collection. These
-- checks cover the pre-projection state, before any Card rows exist.
CREATE FUNCTION "enforce_study_deck_parent_lineage"() RETURNS TRIGGER AS $$
DECLARE
    parent_collection_id TEXT;
BEGIN
    IF NEW."parentDeckId" IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT "sourceCollectionId" INTO parent_collection_id
    FROM "StudyDeck"
    WHERE "id" = NEW."parentDeckId" AND "ownerUserId" = NEW."ownerUserId";
    IF NOT FOUND THEN
        RETURN NEW; -- the composite FK reports the missing parent
    END IF;
    IF parent_collection_id IS DISTINCT FROM NEW."sourceCollectionId" THEN
        RAISE EXCEPTION 'StudyDeck parent belongs to another collection lineage'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StudyDeck_parent_lineage_check"
    BEFORE INSERT OR UPDATE OF "parentDeckId", "ownerUserId", "sourceCollectionId" ON "StudyDeck"
    FOR EACH ROW EXECUTE FUNCTION "enforce_study_deck_parent_lineage"();

CREATE FUNCTION "enforce_study_note_lineage"() RETURNS TRIGGER AS $$
DECLARE
    note_type_collection_id TEXT;
BEGIN
    SELECT "sourceCollectionId" INTO note_type_collection_id
    FROM "StudyNoteType"
    WHERE "id" = NEW."noteTypeId" AND "ownerUserId" = NEW."ownerUserId";
    IF NOT FOUND THEN
        RETURN NEW; -- the composite FK reports the missing note type
    END IF;
    IF note_type_collection_id IS DISTINCT FROM NEW."sourceCollectionId" THEN
        RAISE EXCEPTION 'StudyNote and StudyNoteType belong to different collection lineages'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StudyNote_note_type_lineage_check"
    BEFORE INSERT OR UPDATE OF "noteTypeId", "ownerUserId", "sourceCollectionId" ON "StudyNote"
    FOR EACH ROW EXECUTE FUNCTION "enforce_study_note_lineage"();

CREATE FUNCTION "enforce_import_epoch_lineage"() RETURNS TRIGGER AS $$
DECLARE
    deck_collection_id TEXT;
BEGIN
    SELECT "sourceCollectionId" INTO deck_collection_id
    FROM "StudyDeck"
    WHERE "id" = NEW."studyDeckId" AND "ownerUserId" = NEW."ownerUserId";
    IF NOT FOUND THEN
        RETURN NEW; -- the composite FK reports the missing deck
    END IF;
    IF deck_collection_id IS DISTINCT FROM NEW."sourceCollectionId" THEN
        RAISE EXCEPTION 'ImportEpoch and StudyDeck belong to different collection lineages'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ImportEpoch_deck_lineage_check"
    BEFORE INSERT OR UPDATE OF "studyDeckId", "ownerUserId", "sourceCollectionId" ON "ImportEpoch"
    FOR EACH ROW EXECUTE FUNCTION "enforce_import_epoch_lineage"();

-- Publication is pointer-based, so the pointer and status must describe the
-- same active epoch at commit. Reciprocal deferred triggers allow the worker
-- to update the old status, new status, and pointer in any safe transaction
-- order without ever committing a staging/failed pointer or an orphan active
-- epoch.
CREATE FUNCTION "enforce_study_deck_active_epoch_status"() RETURNS TRIGGER AS $$
DECLARE
    current_active_epoch_id TEXT;
BEGIN
    SELECT "activeEpochId" INTO current_active_epoch_id
    FROM "StudyDeck"
    WHERE "id" = NEW."id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    IF current_active_epoch_id IS NULL
       AND EXISTS (
           SELECT 1
           FROM "ImportEpoch"
           WHERE "studyDeckId" = NEW."id"
             AND "status" = 'active'
       ) THEN
        RAISE EXCEPTION 'StudyDeck without activeEpochId cannot retain an active ImportEpoch'
            USING ERRCODE = '23514';
    END IF;
    IF current_active_epoch_id IS NOT NULL AND NOT EXISTS (
           SELECT 1
           FROM "ImportEpoch"
           WHERE "id" = current_active_epoch_id
             AND "studyDeckId" = NEW."id"
             AND "status" = 'active'
       ) THEN
        RAISE EXCEPTION 'StudyDeck activeEpochId must reference its active ImportEpoch'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "StudyDeck_active_epoch_status_check"
    AFTER INSERT OR UPDATE OF "activeEpochId" ON "StudyDeck"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_study_deck_active_epoch_status"();

CREATE FUNCTION "enforce_import_epoch_active_pointer"() RETURNS TRIGGER AS $$
DECLARE
    current_status "ImportEpochStatus";
    current_study_deck_id TEXT;
    current_active_epoch_id TEXT;
BEGIN
    -- As with the projection cursor constraints below, read the final row
    -- state so a transaction may update the same epoch more than once.
    SELECT "status", "studyDeckId"
    INTO current_status, current_study_deck_id
    FROM "ImportEpoch"
    WHERE "id" = NEW."id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT "activeEpochId" INTO current_active_epoch_id
    FROM "StudyDeck"
    WHERE "id" = current_study_deck_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    IF current_status = 'active'
       AND current_active_epoch_id IS DISTINCT FROM NEW."id" THEN
        RAISE EXCEPTION 'active ImportEpoch must be the StudyDeck activeEpochId'
            USING ERRCODE = '23514';
    END IF;
    IF current_status <> 'active'
       AND current_active_epoch_id IS NOT DISTINCT FROM NEW."id" THEN
        RAISE EXCEPTION 'non-active ImportEpoch cannot be the StudyDeck activeEpochId'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ImportEpoch_active_pointer_check"
    AFTER INSERT OR UPDATE OF "status", "studyDeckId" ON "ImportEpoch"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_import_epoch_active_pointer"();

ALTER TABLE "AnkiObject" ADD CONSTRAINT "AnkiObject_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiObject" ADD CONSTRAINT "AnkiObject_collectionId_ownerUserId_fkey"
    FOREIGN KEY ("collectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiObject" ADD CONSTRAINT "AnkiObject_mappedStudyDeck_lineage_fkey"
    FOREIGN KEY ("mappedStudyDeckId", "ownerUserId", "collectionId") REFERENCES "StudyDeck"("id", "ownerUserId", "sourceCollectionId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AnkiObject" ADD CONSTRAINT "AnkiObject_mappedStudyNoteType_lineage_fkey"
    FOREIGN KEY ("mappedStudyNoteTypeId", "ownerUserId", "collectionId") REFERENCES "StudyNoteType"("id", "ownerUserId", "sourceCollectionId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AnkiObject" ADD CONSTRAINT "AnkiObject_mappedStudyNote_lineage_fkey"
    FOREIGN KEY ("mappedStudyNoteId", "ownerUserId", "collectionId") REFERENCES "StudyNote"("id", "ownerUserId", "sourceCollectionId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AnkiObject" ADD CONSTRAINT "AnkiObject_mappedCardId_fkey"
    FOREIGN KEY ("mappedCardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AnkiCustodyReview" ADD CONSTRAINT "AnkiCustodyReview_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiCustodyReview" ADD CONSTRAINT "AnkiCustodyReview_collectionId_ownerUserId_fkey"
    FOREIGN KEY ("collectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiCustodyReview" ADD CONSTRAINT "AnkiCustodyReview_mappedCardId_fkey"
    FOREIGN KEY ("mappedCardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "AnkiObject_custody_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "kind", "externalId", "revision", "parentExternalId", "noteGuid", "checksum", "contentHash", "decoderVersion", "rawPayload", "isTombstone", "createdAt" ON "AnkiObject"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'kind', 'externalId', 'revision',
        'parentExternalId', 'noteGuid', 'checksum', 'contentHash',
        'decoderVersion', 'rawPayload', 'isTombstone', 'createdAt'
    );

CREATE TRIGGER "AnkiCustodyReview_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "revlogId", "externalCardId", "occurredAt", "ease", "ivl", "lastIvl", "factor", "durationMs", "reviewType", "updateSequence", "rawPayload", "createdAt" ON "AnkiCustodyReview"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'revlogId', 'externalCardId',
        'occurredAt', 'ease', 'ivl', 'lastIvl', 'factor', 'durationMs',
        'reviewType', 'updateSequence', 'rawPayload', 'createdAt'
    );

-- Projection mappings may be populated after raw custody exists, but once a
-- target is recorded it cannot be replaced or cleared under the same raw id.
CREATE FUNCTION "reject_anki_mapping_replacement"() RETURNS TRIGGER AS $$
DECLARE
    mapping_column TEXT;
BEGIN
    FOREACH mapping_column IN ARRAY TG_ARGV LOOP
        IF (to_jsonb(OLD) ->> mapping_column) IS NOT NULL
           AND to_jsonb(OLD) -> mapping_column IS DISTINCT FROM to_jsonb(NEW) -> mapping_column THEN
            RAISE EXCEPTION '% mapping % is write-once', TG_TABLE_NAME, mapping_column
                USING ERRCODE = '23514';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AnkiObject_mappings_write_once"
    BEFORE UPDATE OF "mappedStudyDeckId", "mappedStudyNoteTypeId", "mappedStudyNoteId", "mappedCardId" ON "AnkiObject"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_mapping_replacement"(
        'mappedStudyDeckId', 'mappedStudyNoteTypeId', 'mappedStudyNoteId', 'mappedCardId'
    );

CREATE TRIGGER "AnkiCustodyReview_mapping_write_once"
    BEFORE UPDATE OF "mappedCardId" ON "AnkiCustodyReview"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_mapping_replacement"('mappedCardId');

-- A mapped Card is an imported private projection. It must belong to the same
-- owner and source collection as the raw object/review; shared catalog Cards
-- are deliberately not valid custody mappings.
CREATE FUNCTION "enforce_anki_mapped_card_scope"() RETURNS TRIGGER AS $$
DECLARE
    mapped_owner_user_id TEXT;
    mapped_collection_id TEXT;
BEGIN
    IF NEW."mappedCardId" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT card."ownerUserId", deck."sourceCollectionId"
    INTO mapped_owner_user_id, mapped_collection_id
    FROM "Card" card
    LEFT JOIN "StudyDeck" deck
      ON deck."id" = card."studyDeckId"
     AND deck."ownerUserId" = card."ownerUserId"
    WHERE card."id" = NEW."mappedCardId";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'mapped Card does not exist'
            USING ERRCODE = '23503';
    END IF;
    IF mapped_owner_user_id IS DISTINCT FROM NEW."ownerUserId"
       OR mapped_collection_id IS DISTINCT FROM NEW."collectionId" THEN
        RAISE EXCEPTION 'mapped Card belongs to another owner or collection lineage'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AnkiObject_mappedCard_scope_check"
    BEFORE INSERT OR UPDATE OF "mappedCardId", "ownerUserId", "collectionId" ON "AnkiObject"
    FOR EACH ROW EXECUTE FUNCTION "enforce_anki_mapped_card_scope"();

CREATE TRIGGER "AnkiCustodyReview_mappedCard_scope_check"
    BEFORE INSERT OR UPDATE OF "mappedCardId", "ownerUserId", "collectionId" ON "AnkiCustodyReview"
    FOR EACH ROW EXECUTE FUNCTION "enforce_anki_mapped_card_scope"();

ALTER TABLE "AnkiMedia" ADD CONSTRAINT "AnkiMedia_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiMedia" ADD CONSTRAINT "AnkiMedia_collectionId_ownerUserId_fkey"
    FOREIGN KEY ("collectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TRIGGER "AnkiMedia_custody_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "originalFilename", "collisionKey", "packageIndex", "sizeBytes", "sha1", "sha256", "objectKey", "createdAt" ON "AnkiMedia"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'originalFilename', 'collisionKey',
        'packageIndex', 'sizeBytes', 'sha1', 'sha256', 'objectKey', 'createdAt'
    );

ALTER TABLE "Card" ADD CONSTRAINT "Card_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "Card" ADD CONSTRAINT "Card_studyDeckId_ownerUserId_fkey"
    FOREIGN KEY ("studyDeckId", "ownerUserId") REFERENCES "StudyDeck"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "Card" ADD CONSTRAINT "Card_studyNoteId_ownerUserId_fkey"
    FOREIGN KEY ("studyNoteId", "ownerUserId") REFERENCES "StudyNote"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "Card" ADD CONSTRAINT "Card_importEpochId_studyDeckId_fkey"
    FOREIGN KEY ("importEpochId", "studyDeckId") REFERENCES "ImportEpoch"("id", "studyDeckId") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TRIGGER "Card_private_identity_immutable"
    BEFORE UPDATE OF "ownerUserId", "studyDeckId", "studyNoteId", "importEpochId", "templateOrdinal", "portableCardId" ON "Card"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'ownerUserId', 'studyDeckId', 'studyNoteId', 'importEpochId',
        'templateOrdinal', 'portableCardId'
    );

-- A private imported Card's deck, note, and epoch must resolve to one source
-- collection. This also makes the mapped-Card trigger above a stable lineage
-- proof instead of trusting owner equality alone.
CREATE FUNCTION "enforce_private_card_lineage"() RETURNS TRIGGER AS $$
DECLARE
    deck_collection_id TEXT;
    note_collection_id TEXT;
    epoch_collection_id TEXT;
BEGIN
    IF NEW."studyDeckId" IS NOT NULL THEN
        SELECT "sourceCollectionId" INTO deck_collection_id
        FROM "StudyDeck"
        WHERE "id" = NEW."studyDeckId" AND "ownerUserId" = NEW."ownerUserId";
    END IF;

    IF NEW."studyNoteId" IS NOT NULL THEN
        SELECT "sourceCollectionId" INTO note_collection_id
        FROM "StudyNote"
        WHERE "id" = NEW."studyNoteId" AND "ownerUserId" = NEW."ownerUserId";
        IF NEW."studyDeckId" IS NOT NULL
           AND note_collection_id IS DISTINCT FROM deck_collection_id THEN
            RAISE EXCEPTION 'Card deck and note belong to different collection lineages'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW."importEpochId" IS NOT NULL THEN
        SELECT "sourceCollectionId" INTO epoch_collection_id
        FROM "ImportEpoch"
        WHERE "id" = NEW."importEpochId" AND "studyDeckId" = NEW."studyDeckId";
        IF epoch_collection_id IS DISTINCT FROM deck_collection_id THEN
            RAISE EXCEPTION 'Card deck and import epoch belong to different collection lineages'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Card_private_lineage_check"
    BEFORE INSERT OR UPDATE OF "ownerUserId", "studyDeckId", "studyNoteId", "importEpochId" ON "Card"
    FOR EACH ROW EXECUTE FUNCTION "enforce_private_card_lineage"();

ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_externalCollectionId_userId_fkey"
    FOREIGN KEY ("externalCollectionId", "userId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_ankiCustodyReviewId_userId_fkey"
    FOREIGN KEY ("ankiCustodyReviewId", "userId") REFERENCES "AnkiCustodyReview"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "LearningEvent_anki_identity_immutable"
    BEFORE UPDATE OF "origin", "externalCollectionId", "externalEventId", "ankiCustodyReviewId" ON "LearningEvent"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'origin', 'externalCollectionId', 'externalEventId', 'ankiCustodyReviewId'
    );

-- A projected event's dedupe namespace and its exact review custody must name
-- the same owner and collection. The pair CHECK above guarantees external
-- collection/event identity is all-null or all-set; these reciprocal deferred
-- checks also support a coherent multi-row correction in one transaction.
CREATE FUNCTION "enforce_learning_event_custody_lineage"() RETURNS TRIGGER AS $$
DECLARE
    current_user_id TEXT;
    current_collection_id TEXT;
    current_external_event_id TEXT;
    current_custody_review_id TEXT;
BEGIN
    SELECT "userId", "externalCollectionId", "externalEventId", "ankiCustodyReviewId"
    INTO current_user_id, current_collection_id, current_external_event_id, current_custody_review_id
    FROM "LearningEvent"
    WHERE "id" = NEW."id";

    IF NOT FOUND OR current_custody_review_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF current_collection_id IS NULL OR current_external_event_id IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM "AnkiCustodyReview"
           WHERE "id" = current_custody_review_id
             AND "ownerUserId" = current_user_id
             AND "collectionId" = current_collection_id
             AND ('revlog:' || "revlogId") = current_external_event_id
       ) THEN
        RAISE EXCEPTION 'LearningEvent custody and external collection lineage disagree'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LearningEvent_custody_lineage_check"
    AFTER INSERT OR UPDATE OF "userId", "externalCollectionId", "externalEventId", "ankiCustodyReviewId"
    ON "LearningEvent"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_learning_event_custody_lineage"();

CREATE FUNCTION "enforce_anki_custody_review_event_lineage"() RETURNS TRIGGER AS $$
DECLARE
    current_owner_user_id TEXT;
    current_collection_id TEXT;
    current_revlog_id TEXT;
BEGIN
    SELECT "ownerUserId", "collectionId", "revlogId"
    INTO current_owner_user_id, current_collection_id, current_revlog_id
    FROM "AnkiCustodyReview"
    WHERE "id" = NEW."id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM "LearningEvent"
        WHERE "ankiCustodyReviewId" = NEW."id"
          AND (
              "userId" IS DISTINCT FROM current_owner_user_id
              OR "externalCollectionId" IS DISTINCT FROM current_collection_id
              OR "externalEventId" IS DISTINCT FROM ('revlog:' || current_revlog_id)
          )
    ) THEN
        RAISE EXCEPTION 'AnkiCustodyReview and LearningEvent collection lineage disagree'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "AnkiCustodyReview_event_lineage_check"
    AFTER INSERT OR UPDATE OF "ownerUserId", "collectionId", "revlogId" ON "AnkiCustodyReview"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_anki_custody_review_event_lineage"();

ALTER TABLE "CardProgress" ADD CONSTRAINT "CardProgress_projectedThroughEventId_fkey"
    FOREIGN KEY ("projectedThroughEventId") REFERENCES "LearningEvent"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- CardProgress may target a shared Card or a private Card owned by its user,
-- but cannot create progress against another user's private content.
CREATE FUNCTION "enforce_card_progress_card_scope"() RETURNS TRIGGER AS $$
DECLARE
    card_owner_user_id TEXT;
BEGIN
    SELECT "ownerUserId" INTO card_owner_user_id
    FROM "Card"
    WHERE "id" = NEW."cardId";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CardProgress Card does not exist'
            USING ERRCODE = '23503';
    END IF;
    IF card_owner_user_id IS NOT NULL
       AND card_owner_user_id IS DISTINCT FROM NEW."userId" THEN
        RAISE EXCEPTION 'CardProgress cannot target another user''s private Card'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CardProgress_card_scope_check"
    BEFORE INSERT OR UPDATE OF "cardId", "userId" ON "CardProgress"
    FOR EACH ROW EXECUTE FUNCTION "enforce_card_progress_card_scope"();

-- The Prisma relation remains id-only so ON DELETE SET NULL does not attempt
-- to null the non-null CardProgress.userId. Deferred reciprocal triggers still
-- guarantee the cursor and event belong to the same user and Card, while
-- allowing the existing guest-progress claim transaction to transfer both
-- rows together.
CREATE FUNCTION "enforce_card_progress_projection_user"() RETURNS TRIGGER AS $$
DECLARE
    current_event_id TEXT;
    current_user_id TEXT;
    current_card_id TEXT;
BEGIN
    -- A deferred trigger can observe multiple updates to the same row. Read
    -- the final row state instead of validating a stale queued NEW tuple.
    SELECT "projectedThroughEventId", "userId", "cardId"
    INTO current_event_id, current_user_id, current_card_id
    FROM "CardProgress"
    WHERE "id" = NEW."id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    IF current_event_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM "LearningEvent"
           WHERE "id" = current_event_id
             AND "userId" = current_user_id
             AND "sourceType" = 'card'
             AND "sourceId" = current_card_id
       ) THEN
        RAISE EXCEPTION 'CardProgress projection cursor belongs to another user or Card'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "CardProgress_projection_user_check"
    AFTER INSERT OR UPDATE ON "CardProgress"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_card_progress_projection_user"();

CREATE FUNCTION "enforce_learning_event_projection_users"() RETURNS TRIGGER AS $$
DECLARE
    current_user_id TEXT;
    current_source_type TEXT;
    current_source_id TEXT;
BEGIN
    SELECT "userId", "sourceType", "sourceId"
    INTO current_user_id, current_source_type, current_source_id
    FROM "LearningEvent"
    WHERE "id" = NEW."id";

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM "CardProgress"
        WHERE "projectedThroughEventId" = NEW."id"
          AND (
              "userId" IS DISTINCT FROM current_user_id
              OR current_source_type IS DISTINCT FROM 'card'
              OR current_source_id IS DISTINCT FROM "cardId"
          )
    ) THEN
        RAISE EXCEPTION 'LearningEvent projection cursor belongs to another user or Card'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LearningEvent_projection_user_check"
    AFTER UPDATE OF "userId", "sourceType", "sourceId" ON "LearningEvent"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "enforce_learning_event_projection_users"();
