-- Cross-instance fixed-window rate limiting. Bucket keys are SHA-256 digests,
-- not raw IP addresses or user identifiers. One row is reused per bucket.
CREATE TABLE IF NOT EXISTS "RateLimitBucket" (
    "key" VARCHAR(71) NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "RateLimitBucket_expiresAt_idx"
    ON "RateLimitBucket"("expiresAt");
