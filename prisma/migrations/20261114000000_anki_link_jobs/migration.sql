-- Anki link AI queue: the add-on's check/write requests wait here for a worker on the owner's Mac
-- (subscription engine + guideline library); md3 itself never calls a model for them.
CREATE TABLE "AnkiLinkJob" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "items" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMPTZ(3),
    "worker" TEXT,
    "engine" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AnkiLinkJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnkiLinkJob_kind_check" CHECK ("kind" IN ('check', 'write')),
    CONSTRAINT "AnkiLinkJob_state_check" CHECK ("state" IN ('queued', 'running', 'done', 'failed'))
);

CREATE INDEX "AnkiLinkJob_state_created_idx" ON "AnkiLinkJob"("state", "createdAt");
CREATE INDEX "AnkiLinkJob_peer_created_idx" ON "AnkiLinkJob"("peerId", "createdAt");
CREATE INDEX "AnkiLinkJob_expiry_idx" ON "AnkiLinkJob"("expiresAt");

ALTER TABLE "AnkiLinkJob" ADD CONSTRAINT "AnkiLinkJob_peer_fkey"
  FOREIGN KEY ("peerId") REFERENCES "AnkiSyncPeer"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
