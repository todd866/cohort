-- Cross-instance single flight for background study-queue and offline-pack
-- builds (src/lib/study/session-refresh-lease.ts). One row per build in flight
-- for a (learner, scope), deleted when the build finishes and taken over after
-- expiresAt when a holder dies. A new, empty table, so the create takes no lock
-- that a live query could be waiting on.

-- CreateTable
CREATE TABLE "SessionRefreshLease" (
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "acquiredAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SessionRefreshLease_pkey" PRIMARY KEY ("userId","scope")
);
