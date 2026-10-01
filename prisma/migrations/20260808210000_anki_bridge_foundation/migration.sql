-- Cohort Bridge milestone 1: short-lived pairing, hashed device credentials,
-- and Anki-authoritative Anki-to-Cohort incremental custody. This migration is
-- additive and depends on 20260808170000_anki_portability_foundation.

ALTER TABLE "AnkiMedia"
    ADD COLUMN "bridgeUploadExpiresAt" TIMESTAMPTZ(3),
    ADD COLUMN "bridgeUploadedAt" TIMESTAMPTZ(3);

ALTER TABLE "AnkiMedia" ADD CONSTRAINT "AnkiMedia_bridge_upload_window_check" CHECK (
    "bridgeUploadedAt" IS NULL OR (
        "bridgeUploadExpiresAt" IS NOT NULL
        AND "bridgeUploadedAt" >= "createdAt"
    )
);

CREATE TABLE "AnkiBridgePairing" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnkiBridgePairing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiBridgePairing_code_hash_check" CHECK ("codeHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "AnkiBridgePairing_expiry_check" CHECK (
        "expiresAt" > "createdAt"
        AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'
    ),
    CONSTRAINT "AnkiBridgePairing_attempt_count_check" CHECK ("attemptCount" >= 0 AND "attemptCount" <= 5),
    CONSTRAINT "AnkiBridgePairing_terminal_shape_check" CHECK (
        NOT ("consumedAt" IS NOT NULL AND "cancelledAt" IS NOT NULL)
        AND ("consumedAt" IS NULL OR ("consumedAt" >= "createdAt" AND "consumedAt" <= "expiresAt"))
        AND ("cancelledAt" IS NULL OR "cancelledAt" >= "createdAt")
    )
);

CREATE TABLE "AnkiSyncPeer" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "protocolVersion" INTEGER NOT NULL,
    "addonVersion" TEXT NOT NULL,
    "ankiVersion" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "syncMode" TEXT NOT NULL DEFAULT 'anki_to_cohort',
    "revokedAt" TIMESTAMPTZ(3),
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AnkiSyncPeer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiSyncPeer_milestone_one_check" CHECK (
        "credentialVersion" = 1
        AND "protocolVersion" = 1
        AND "syncMode" = 'anki_to_cohort'
    ),
    CONSTRAINT "AnkiSyncPeer_credential_hash_check" CHECK ("credentialHash" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "AnkiSyncCursor" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'anki_to_cohort',
    "acknowledgedThroughSequence" BIGINT NOT NULL DEFAULT 0,
    "nextExpectedSequence" BIGINT NOT NULL DEFAULT 1,
    "lastOperationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AnkiSyncCursor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiSyncCursor_direction_check" CHECK ("direction" = 'anki_to_cohort'),
    CONSTRAINT "AnkiSyncCursor_sequence_check" CHECK (
        "acknowledgedThroughSequence" >= 0
        AND "nextExpectedSequence" = "acknowledgedThroughSequence" + 1
    )
);

CREATE TABLE "AnkiBridgeOperation" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "batchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "result" JSONB,
    "appliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnkiBridgeOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiBridgeOperation_sequence_check" CHECK ("sequence" > 0),
    CONSTRAINT "AnkiBridgeOperation_payload_hash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "AnkiBridgeOperation_status_check" CHECK ("status" IN ('applied', 'conflict')),
    CONSTRAINT "AnkiBridgeOperation_kind_check" CHECK (
        "kind" IN ('object.upsert', 'review.upsert', 'media.upsert', 'eligibility.upsert')
    )
);

CREATE TABLE "AnkiConflict" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "bridgeOperationId" TEXT,
    "incomingOperationId" TEXT NOT NULL,
    "incomingSequence" BIGINT NOT NULL,
    "conflictType" TEXT NOT NULL,
    "objectKind" TEXT,
    "externalId" TEXT,
    "revision" TEXT,
    "localHash" TEXT,
    "remoteHash" TEXT NOT NULL,
    "details" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AnkiConflict_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiConflict_status_check" CHECK ("status" IN ('open', 'resolved')),
    CONSTRAINT "AnkiConflict_hash_check" CHECK (
        ("localHash" IS NULL OR "localHash" ~ '^[a-f0-9]{64}$')
        AND "remoteHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE TABLE "AnkiEligibilityState" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "externalCardId" TEXT NOT NULL,
    "queue" INTEGER NOT NULL,
    "cardType" INTEGER NOT NULL,
    "due" TEXT NOT NULL,
    "interval" INTEGER NOT NULL,
    "suspended" BOOLEAN NOT NULL,
    "buried" BOOLEAN NOT NULL,
    "fsrsDataHash" TEXT,
    "rawState" JSONB NOT NULL,
    "bridgeSequence" BIGINT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AnkiEligibilityState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiEligibilityState_sequence_check" CHECK ("bridgeSequence" > 0),
    CONSTRAINT "AnkiEligibilityState_fsrs_hash_check" CHECK (
        "fsrsDataHash" IS NULL OR "fsrsDataHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE UNIQUE INDEX "AnkiBridgePairing_codeHash_key" ON "AnkiBridgePairing"("codeHash");
CREATE UNIQUE INDEX "AnkiBridgePairing_id_owner_collection_key" ON "AnkiBridgePairing"("id", "ownerUserId", "collectionId");
CREATE INDEX "AnkiBridgePairing_owner_expiry_idx" ON "AnkiBridgePairing"("ownerUserId", "expiresAt");
CREATE INDEX "AnkiBridgePairing_collection_expiry_idx" ON "AnkiBridgePairing"("collectionId", "expiresAt");

CREATE UNIQUE INDEX "AnkiSyncPeer_credentialHash_key" ON "AnkiSyncPeer"("credentialHash");
CREATE UNIQUE INDEX "AnkiSyncPeer_id_owner_collection_key" ON "AnkiSyncPeer"("id", "ownerUserId", "collectionId");
CREATE UNIQUE INDEX "AnkiSyncPeer_one_active_per_collection_key" ON "AnkiSyncPeer"("collectionId") WHERE "revokedAt" IS NULL;
CREATE INDEX "AnkiSyncPeer_owner_revoked_idx" ON "AnkiSyncPeer"("ownerUserId", "revokedAt");
CREATE INDEX "AnkiSyncPeer_collection_revoked_idx" ON "AnkiSyncPeer"("collectionId", "revokedAt");

CREATE UNIQUE INDEX "AnkiSyncCursor_peer_direction_key" ON "AnkiSyncCursor"("peerId", "direction");
CREATE INDEX "AnkiSyncCursor_owner_collection_idx" ON "AnkiSyncCursor"("ownerUserId", "collectionId");

CREATE UNIQUE INDEX "AnkiBridgeOperation_id_scope_key" ON "AnkiBridgeOperation"("id", "ownerUserId", "collectionId", "peerId");
CREATE UNIQUE INDEX "AnkiBridgeOperation_peer_operation_key" ON "AnkiBridgeOperation"("peerId", "operationId");
CREATE UNIQUE INDEX "AnkiBridgeOperation_peer_sequence_key" ON "AnkiBridgeOperation"("peerId", "sequence");
CREATE INDEX "AnkiBridgeOperation_owner_collection_status_idx" ON "AnkiBridgeOperation"("ownerUserId", "collectionId", "status");
CREATE INDEX "AnkiBridgeOperation_peer_status_sequence_idx" ON "AnkiBridgeOperation"("peerId", "status", "sequence");

CREATE INDEX "AnkiConflict_owner_status_created_idx" ON "AnkiConflict"("ownerUserId", "status", "createdAt");
CREATE INDEX "AnkiConflict_collection_status_idx" ON "AnkiConflict"("collectionId", "status");
CREATE INDEX "AnkiConflict_peer_status_idx" ON "AnkiConflict"("peerId", "status");
CREATE UNIQUE INDEX "AnkiConflict_peer_operation_remote_key" ON "AnkiConflict"("peerId", "incomingOperationId", "remoteHash");

CREATE UNIQUE INDEX "AnkiEligibilityState_collection_card_key" ON "AnkiEligibilityState"("collectionId", "externalCardId");
CREATE INDEX "AnkiEligibilityState_owner_collection_eligibility_idx" ON "AnkiEligibilityState"("ownerUserId", "collectionId", "suspended", "buried");
CREATE INDEX "AnkiEligibilityState_peer_sequence_idx" ON "AnkiEligibilityState"("peerId", "bridgeSequence");

ALTER TABLE "AnkiBridgePairing" ADD CONSTRAINT "AnkiBridgePairing_owner_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiBridgePairing" ADD CONSTRAINT "AnkiBridgePairing_collection_owner_fkey"
    FOREIGN KEY ("collectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "AnkiSyncPeer" ADD CONSTRAINT "AnkiSyncPeer_owner_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiSyncPeer" ADD CONSTRAINT "AnkiSyncPeer_collection_owner_fkey"
    FOREIGN KEY ("collectionId", "ownerUserId") REFERENCES "AnkiCollection"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "AnkiSyncCursor" ADD CONSTRAINT "AnkiSyncCursor_peer_scope_fkey"
    FOREIGN KEY ("peerId", "ownerUserId", "collectionId") REFERENCES "AnkiSyncPeer"("id", "ownerUserId", "collectionId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "AnkiBridgeOperation" ADD CONSTRAINT "AnkiBridgeOperation_peer_scope_fkey"
    FOREIGN KEY ("peerId", "ownerUserId", "collectionId") REFERENCES "AnkiSyncPeer"("id", "ownerUserId", "collectionId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "AnkiConflict" ADD CONSTRAINT "AnkiConflict_peer_scope_fkey"
    FOREIGN KEY ("peerId", "ownerUserId", "collectionId") REFERENCES "AnkiSyncPeer"("id", "ownerUserId", "collectionId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "AnkiConflict" ADD CONSTRAINT "AnkiConflict_operation_scope_fkey"
    FOREIGN KEY ("bridgeOperationId", "ownerUserId", "collectionId", "peerId") REFERENCES "AnkiBridgeOperation"("id", "ownerUserId", "collectionId", "peerId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "AnkiEligibilityState" ADD CONSTRAINT "AnkiEligibilityState_peer_scope_fkey"
    FOREIGN KEY ("peerId", "ownerUserId", "collectionId") REFERENCES "AnkiSyncPeer"("id", "ownerUserId", "collectionId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Bridge custody identifiers are write-once. Status, cursor, heartbeat, and
-- resolution fields remain mutable through their bounded state machines.
CREATE TRIGGER "AnkiBridgePairing_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "codeHash", "expiresAt", "createdAt" ON "AnkiBridgePairing"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'codeHash', 'expiresAt', 'createdAt'
    );

CREATE TRIGGER "AnkiSyncPeer_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "credentialHash", "credentialVersion", "protocolVersion", "syncMode", "createdAt" ON "AnkiSyncPeer"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'credentialHash',
        'credentialVersion', 'protocolVersion', 'syncMode', 'createdAt'
    );

CREATE TRIGGER "AnkiSyncCursor_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "peerId", "direction", "createdAt" ON "AnkiSyncCursor"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'peerId', 'direction', 'createdAt'
    );

CREATE TRIGGER "AnkiBridgeOperation_custody_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "peerId", "operationId", "sequence", "batchId", "kind", "payloadHash", "payload", "createdAt" ON "AnkiBridgeOperation"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'peerId', 'operationId',
        'sequence', 'batchId', 'kind', 'payloadHash', 'payload', 'createdAt'
    );

CREATE TRIGGER "AnkiConflict_custody_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "peerId", "bridgeOperationId", "incomingOperationId", "incomingSequence", "conflictType", "objectKind", "externalId", "revision", "localHash", "remoteHash", "createdAt" ON "AnkiConflict"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'peerId', 'bridgeOperationId',
        'incomingOperationId', 'incomingSequence', 'conflictType', 'objectKind',
        'externalId', 'revision', 'localHash', 'remoteHash', 'createdAt'
    );

CREATE TRIGGER "AnkiEligibilityState_identity_immutable"
    BEFORE UPDATE OF "id", "ownerUserId", "collectionId", "peerId", "externalCardId", "createdAt" ON "AnkiEligibilityState"
    FOR EACH ROW EXECUTE FUNCTION "reject_anki_identity_update"(
        'id', 'ownerUserId', 'collectionId', 'peerId', 'externalCardId', 'createdAt'
    );
