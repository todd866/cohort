-- Durable owner-scoped Anki export jobs. Export requests enqueue only; release
-- requires a separate official-Anki worker, post-build reparse, fresh-profile
-- round trip, and signed fidelity attestation.

CREATE TYPE "AnkiExportMode" AS ENUM ('continue_in_anki', 'share_clean');
CREATE TYPE "AnkiExportStatus" AS ENUM ('queued', 'building', 'released', 'blocked', 'expired', 'cancelled');

CREATE TABLE "AnkiExportJob" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "mode" "AnkiExportMode" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "status" "AnkiExportStatus" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseAcquiredAt" TIMESTAMPTZ(3),
    "leaseHeartbeatAt" TIMESTAMPTZ(3),
    "cutoffAt" TIMESTAMPTZ(3) NOT NULL,
    "planId" TEXT,
    "artifactObjectKey" TEXT,
    "artifactSizeBytes" BIGINT,
    "artifactArchiveSha256" TEXT,
    "artifactManifestSha256" TEXT,
    "artifactExpiresAt" TIMESTAMPTZ(3),
    "downloadGrantIssuedAt" TIMESTAMPTZ(3),
    "downloadGrantExpiresAt" TIMESTAMPTZ(3),
    "fidelityReport" JSONB,
    "roundTripEvidence" JSONB,
    "blockedCode" TEXT,
    "blockedMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "downloadedAt" TIMESTAMPTZ(3),
    CONSTRAINT "AnkiExportJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiExportJob_request_sha256_check" CHECK ("requestSha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "AnkiExportJob_archive_sha256_check" CHECK ("artifactArchiveSha256" IS NULL OR "artifactArchiveSha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "AnkiExportJob_manifest_sha256_check" CHECK ("artifactManifestSha256" IS NULL OR "artifactManifestSha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "AnkiExportJob_attempt_check" CHECK ("attempt" >= 0),
    CONSTRAINT "AnkiExportJob_artifact_size_check" CHECK ("artifactSizeBytes" IS NULL OR "artifactSizeBytes" > 0),
    CONSTRAINT "AnkiExportJob_lease_shape_check" CHECK (
      (
        "status" = 'building'
        AND "leaseToken" IS NOT NULL
        AND "leaseAcquiredAt" IS NOT NULL
        AND "leaseHeartbeatAt" IS NOT NULL
      ) OR (
        "status" <> 'building'
        AND "leaseToken" IS NULL
        AND "leaseAcquiredAt" IS NULL
        AND "leaseHeartbeatAt" IS NULL
      )
    ),
    CONSTRAINT "AnkiExportJob_lease_order_check" CHECK (
      "leaseHeartbeatAt" IS NULL OR "leaseHeartbeatAt" >= "leaseAcquiredAt"
    ),
    CONSTRAINT "AnkiExportJob_artifact_shape_check" CHECK (
      (
        "artifactObjectKey" IS NULL
        AND "artifactSizeBytes" IS NULL
        AND "artifactArchiveSha256" IS NULL
        AND "artifactManifestSha256" IS NULL
        AND "artifactExpiresAt" IS NULL
      ) OR (
        "artifactObjectKey" IS NOT NULL
        AND "artifactSizeBytes" IS NOT NULL
        AND "artifactArchiveSha256" IS NOT NULL
        AND "artifactManifestSha256" IS NOT NULL
        AND "artifactExpiresAt" IS NOT NULL
        AND "completedAt" IS NOT NULL
        AND "artifactExpiresAt" > "completedAt"
        AND "artifactExpiresAt" <= "completedAt" + INTERVAL '7 days'
        AND "ownerUserId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
        AND "id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
        AND "artifactObjectKey" = 'private/anki/exports/' || "ownerUserId" || '/' || "id" || '/' || "artifactArchiveSha256" || '.apkg'
      )
    ),
    CONSTRAINT "AnkiExportJob_download_grant_check" CHECK (
      (
        "downloadGrantIssuedAt" IS NULL
        AND "downloadGrantExpiresAt" IS NULL
      ) OR (
        "downloadGrantIssuedAt" IS NOT NULL
        AND "downloadGrantExpiresAt" IS NOT NULL
        AND "status" = 'released'
        AND "artifactExpiresAt" IS NOT NULL
        AND "completedAt" IS NOT NULL
        AND "downloadGrantIssuedAt" >= "completedAt"
        AND "downloadGrantExpiresAt" > "downloadGrantIssuedAt"
        AND "downloadGrantExpiresAt" <= "downloadGrantIssuedAt" + INTERVAL '5 minutes'
        AND "downloadGrantExpiresAt" <= "artifactExpiresAt"
      )
    ),
    CONSTRAINT "AnkiExportJob_release_shape_check" CHECK (
      "status" <> 'released' OR (
        "planId" IS NOT NULL
        AND "artifactObjectKey" IS NOT NULL
        AND "artifactSizeBytes" IS NOT NULL
        AND "artifactArchiveSha256" IS NOT NULL
        AND "artifactManifestSha256" IS NOT NULL
        AND "artifactExpiresAt" IS NOT NULL
        AND "fidelityReport" IS NOT NULL
        AND "roundTripEvidence" IS NOT NULL
        AND "completedAt" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "AnkiExportJob_id_owner_key" ON "AnkiExportJob"("id", "ownerUserId");
CREATE UNIQUE INDEX "AnkiExportJob_owner_idempotency_key" ON "AnkiExportJob"("ownerUserId", "idempotencyKey");
CREATE INDEX "AnkiExportJob_owner_status_created_idx" ON "AnkiExportJob"("ownerUserId", "status", "createdAt");
CREATE INDEX "AnkiExportJob_collection_status_idx" ON "AnkiExportJob"("collectionId", "status");
CREATE INDEX "AnkiExportJob_status_lease_idx" ON "AnkiExportJob"("status", "leaseHeartbeatAt", "leaseAcquiredAt");
CREATE INDEX "AnkiExportJob_artifact_expiry_idx" ON "AnkiExportJob"("artifactExpiresAt");

ALTER TABLE "AnkiExportJob" ADD CONSTRAINT "AnkiExportJob_owner_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiExportJob" ADD CONSTRAINT "AnkiExportJob_collection_owner_fkey"
    FOREIGN KEY ("collectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TRIGGER "AnkiExportJob_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "mode", "idempotencyKey", "requestSha256", "cutoffAt", "createdAt" ON "AnkiExportJob"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'mode', 'idempotencyKey',
        'requestSha256', 'cutoffAt', 'createdAt'
    );

-- Artifact custody may be populated once by a successful official-Anki build,
-- but it cannot later be replaced under the same job/idempotency identity.
CREATE FUNCTION "reject_anki_export_artifact_replacement"() RETURNS TRIGGER AS $$
BEGIN
    IF OLD."artifactObjectKey" IS NOT NULL AND (
        OLD."artifactObjectKey" IS DISTINCT FROM NEW."artifactObjectKey"
        OR OLD."artifactSizeBytes" IS DISTINCT FROM NEW."artifactSizeBytes"
        OR OLD."artifactArchiveSha256" IS DISTINCT FROM NEW."artifactArchiveSha256"
        OR OLD."artifactManifestSha256" IS DISTINCT FROM NEW."artifactManifestSha256"
        OR OLD."artifactExpiresAt" IS DISTINCT FROM NEW."artifactExpiresAt"
        OR OLD."completedAt" IS DISTINCT FROM NEW."completedAt"
    ) THEN
        RAISE EXCEPTION 'released Anki export artifact custody is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AnkiExportJob_artifact_immutable"
    BEFORE UPDATE OF "artifactObjectKey", "artifactSizeBytes", "artifactArchiveSha256", "artifactManifestSha256", "artifactExpiresAt", "completedAt" ON "AnkiExportJob"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_export_artifact_replacement"();
