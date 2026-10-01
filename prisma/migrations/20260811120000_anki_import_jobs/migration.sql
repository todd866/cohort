-- Durable inbound .apkg workflow. Package bytes remain in the dedicated
-- private user-documents bucket and the collection is the custody root.
CREATE TYPE "AnkiImportJobState" AS ENUM (
    'awaiting_upload',
    'inspecting',
    'preview_ready',
    'importing',
    'active',
    'failed',
    'cancelled'
);

CREATE TABLE "AnkiImportJob" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "state" "AnkiImportJobState" NOT NULL DEFAULT 'awaiting_upload',
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "rawObjectKey" TEXT NOT NULL,
    "uploadUrlExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3),
    "inspectedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "preview" JSONB,
    "projectionMode" TEXT,
    "targetRotation" TEXT,
    "failureCode" TEXT,
    "publicMessage" TEXT,
    "leaseToken" TEXT,
    "leaseAcquiredAt" TIMESTAMPTZ(3),
    "leaseHeartbeatAt" TIMESTAMPTZ(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "deletionRequestedAt" TIMESTAMPTZ(3),
    "deleteAfter" TIMESTAMPTZ(3),
    "rawDeletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AnkiImportJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiImportJob_size_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 52428800),
    CONSTRAINT "AnkiImportJob_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "AnkiImportJob_request_hash_check" CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "AnkiImportJob_filename_check" CHECK (
        char_length("filename") BETWEEN 1 AND 255
        AND lower(right("filename", 5)) = '.apkg'
        AND "filename" !~ '[\\/[:cntrl:]]'
        AND "filename" !~ '[‪-‮⁦-⁩]'
    ),
    CONSTRAINT "AnkiImportJob_idempotency_key_check" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    CONSTRAINT "AnkiImportJob_failure_code_check" CHECK (
        "failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,79}$'
    ),
    CONSTRAINT "AnkiImportJob_public_message_check" CHECK (
        "publicMessage" IS NULL OR (
            char_length("publicMessage") BETWEEN 1 AND 240
            AND "publicMessage" !~ '[[:cntrl:]]'
        )
    ),
    CONSTRAINT "AnkiImportJob_lease_token_check" CHECK (
        "leaseToken" IS NULL OR (
            char_length("leaseToken") BETWEEN 1 AND 128
            AND "leaseToken" !~ '[[:cntrl:]]'
        )
    ),
    CONSTRAINT "AnkiImportJob_attempt_count_check" CHECK (
        "attemptCount" BETWEEN 0 AND 100
    ),
    CONSTRAINT "AnkiImportJob_projection_mode_check" CHECK (
        "projectionMode" IS NULL OR "projectionMode" IN ('cards_only', 'current_state', 'history')
    ),
    CONSTRAINT "AnkiImportJob_target_rotation_check" CHECK (
        "targetRotation" IS NULL OR "targetRotation" IN (
            'critical-care', 'cah', 'paam', 'pwh', 'usmle-step1'
        )
    ),
    CONSTRAINT "AnkiImportJob_state_payload_check" CHECK (
        ("state" IN ('awaiting_upload', 'inspecting') AND "preview" IS NULL AND "confirmedAt" IS NULL)
        OR ("state" = 'preview_ready' AND "uploadedAt" IS NOT NULL AND "preview" IS NOT NULL AND "inspectedAt" IS NOT NULL AND "confirmedAt" IS NULL)
        OR ("state" IN ('importing', 'active') AND "uploadedAt" IS NOT NULL AND "preview" IS NOT NULL AND "inspectedAt" IS NOT NULL AND "confirmedAt" IS NOT NULL AND "projectionMode" IS NOT NULL AND "targetRotation" IS NOT NULL)
        OR ("state" IN ('failed', 'cancelled'))
    ),
    CONSTRAINT "AnkiImportJob_lease_check" CHECK (
        ("state" IN ('inspecting', 'importing') AND "leaseToken" IS NOT NULL AND "leaseAcquiredAt" IS NOT NULL AND "leaseHeartbeatAt" IS NOT NULL)
        OR ("state" NOT IN ('inspecting', 'importing') AND "leaseToken" IS NULL AND "leaseAcquiredAt" IS NULL AND "leaseHeartbeatAt" IS NULL)
    ),
    CONSTRAINT "AnkiImportJob_deletion_check" CHECK (
        ("deletionRequestedAt" IS NULL AND "deleteAfter" IS NULL AND "rawDeletedAt" IS NULL)
        OR (
            "deletionRequestedAt" IS NOT NULL
            AND "deleteAfter" IS NOT NULL
            AND "state" = 'cancelled'
            AND ("rawDeletedAt" IS NULL OR "rawDeletedAt" >= "deletionRequestedAt")
        )
    ),
    CONSTRAINT "AnkiImportJob_raw_object_key_check" CHECK (
        "rawObjectKey" = 'anki-imports/raw/' || "ownerUserId" || '/' || "collectionId" || '/' || "id" || '.apkg'
    )
);

CREATE UNIQUE INDEX "AnkiImportJob_collectionId_key" ON "AnkiImportJob"("collectionId");
CREATE UNIQUE INDEX "AnkiImportJob_id_ownerUserId_key" ON "AnkiImportJob"("id", "ownerUserId");
CREATE UNIQUE INDEX "AnkiImportJob_collectionId_ownerUserId_key" ON "AnkiImportJob"("collectionId", "ownerUserId");
CREATE UNIQUE INDEX "AnkiImportJob_ownerUserId_idempotencyKey_key" ON "AnkiImportJob"("ownerUserId", "idempotencyKey");
CREATE INDEX "AnkiImportJob_ownerUserId_createdAt_idx" ON "AnkiImportJob"("ownerUserId", "createdAt");
CREATE INDEX "AnkiImportJob_state_leaseHeartbeatAt_idx" ON "AnkiImportJob"("state", "leaseHeartbeatAt");
CREATE INDEX "AnkiImportJob_state_deleteAfter_idx" ON "AnkiImportJob"("state", "deleteAfter");

ALTER TABLE "AnkiImportJob" ADD CONSTRAINT "AnkiImportJob_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiImportJob" ADD CONSTRAINT "AnkiImportJob_collectionId_ownerUserId_fkey"
    FOREIGN KEY ("collectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TRIGGER "AnkiImportJob_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "filename", "sizeBytes", "sha256", "idempotencyKey", "requestHash", "rawObjectKey", "createdAt" ON "AnkiImportJob"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'filename', 'sizeBytes', 'sha256',
        'idempotencyKey', 'requestHash', 'rawObjectKey', 'createdAt'
    );

-- The workflow may only advance along declared edges. `failed` can be retried
-- through a fresh idempotency key; cancellation is terminal.
CREATE FUNCTION "enforce_anki_import_state_transition"() RETURNS TRIGGER AS $$
BEGIN
    IF OLD."state" = NEW."state" THEN
        RETURN NEW;
    END IF;
    IF NOT (
        (OLD."state" = 'awaiting_upload' AND NEW."state" IN ('inspecting', 'failed', 'cancelled'))
        OR (OLD."state" = 'inspecting' AND NEW."state" IN ('preview_ready', 'failed'))
        OR (OLD."state" = 'preview_ready' AND NEW."state" IN ('importing', 'cancelled'))
        OR (OLD."state" = 'importing' AND NEW."state" IN ('active', 'failed'))
        OR (OLD."state" = 'failed' AND NEW."state" = 'cancelled')
    ) THEN
        RAISE EXCEPTION 'invalid Anki import transition: % -> %', OLD."state", NEW."state"
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AnkiImportJob_state_transition_check"
    BEFORE UPDATE OF "state" ON "AnkiImportJob"
    FOR EACH ROW EXECUTE FUNCTION "enforce_anki_import_state_transition"();
