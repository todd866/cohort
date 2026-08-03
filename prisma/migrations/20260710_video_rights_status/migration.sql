-- Video tables were introduced through historical schema pushes rather than a
-- reproducible migration. Create their current pre-rights shape idempotently so
-- a fresh database and an already-pushed production database converge.
CREATE TABLE IF NOT EXISTS "VideoCreator" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "email" TEXT,
    "website" TEXT,
    "otherContact" TEXT,
    "permissionStatus" TEXT NOT NULL DEFAULT 'pending',
    "contactMethod" TEXT,
    "askedAt" TIMESTAMPTZ(3),
    "respondedAt" TIMESTAMPTZ(3),
    "responseNotes" TEXT,
    "contentType" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "VideoCreator_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Video" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "caption" TEXT,
    "transcript" TEXT,
    "r2Key" TEXT NOT NULL,
    "thumbnailR2Key" TEXT,
    "durationSecs" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rotation" TEXT,
    "week" INTEGER,
    "creatorName" TEXT NOT NULL DEFAULT 'Unknown',
    "creatorHandle" TEXT,
    "creatorUrl" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "sourceMeta" JSONB,
    "complexity" INTEGER,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "feedScore" INTEGER NOT NULL DEFAULT 0,
    "tone" TEXT NOT NULL DEFAULT 'educational',
    "seriousness" DOUBLE PRECISION,
    "pedagogy" JSONB,
    "requiredTier" TEXT NOT NULL DEFAULT 'visitor',
    "clusterId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VideoConcept" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "VideoConcept_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VideoProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "watched" BOOLEAN NOT NULL DEFAULT false,
    "watchedAt" TIMESTAMPTZ(3),
    "liked" BOOLEAN NOT NULL DEFAULT false,
    "bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "watchedSecs" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "VideoProgress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "video_embeddings" (
    "id" TEXT NOT NULL,
    "video_id" TEXT NOT NULL,
    "embedding" halfvec(3072) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VideoCreator_handle_key" ON "VideoCreator"("handle");
CREATE INDEX IF NOT EXISTS "VideoCreator_permissionStatus_idx" ON "VideoCreator"("permissionStatus");
CREATE UNIQUE INDEX IF NOT EXISTS "Video_r2Key_key" ON "Video"("r2Key");
CREATE UNIQUE INDEX IF NOT EXISTS "Video_sourceUrl_key" ON "Video"("sourceUrl");
CREATE INDEX IF NOT EXISTS "Video_rotation_idx" ON "Video"("rotation");
CREATE INDEX IF NOT EXISTS "Video_published_idx" ON "Video"("published");
CREATE INDEX IF NOT EXISTS "Video_createdAt_idx" ON "Video"("createdAt");
CREATE INDEX IF NOT EXISTS "Video_feedScore_idx" ON "Video"("feedScore");
CREATE INDEX IF NOT EXISTS "Video_clusterId_idx" ON "Video"("clusterId");
CREATE UNIQUE INDEX IF NOT EXISTS "VideoConcept_videoId_conceptId_key" ON "VideoConcept"("videoId", "conceptId");
CREATE INDEX IF NOT EXISTS "VideoConcept_conceptId_idx" ON "VideoConcept"("conceptId");
CREATE INDEX IF NOT EXISTS "VideoConcept_videoId_idx" ON "VideoConcept"("videoId");
CREATE UNIQUE INDEX IF NOT EXISTS "VideoProgress_userId_videoId_key" ON "VideoProgress"("userId", "videoId");
CREATE INDEX IF NOT EXISTS "VideoProgress_userId_idx" ON "VideoProgress"("userId");
CREATE INDEX IF NOT EXISTS "VideoProgress_videoId_idx" ON "VideoProgress"("videoId");
CREATE UNIQUE INDEX IF NOT EXISTS "video_embeddings_video_id_key" ON "video_embeddings"("video_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Video_clusterId_fkey') THEN
    ALTER TABLE "Video" ADD CONSTRAINT "Video_clusterId_fkey"
      FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VideoConcept_videoId_fkey') THEN
    ALTER TABLE "VideoConcept" ADD CONSTRAINT "VideoConcept_videoId_fkey"
      FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VideoConcept_conceptId_fkey') THEN
    ALTER TABLE "VideoConcept" ADD CONSTRAINT "VideoConcept_conceptId_fkey"
      FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VideoProgress_userId_fkey') THEN
    ALTER TABLE "VideoProgress" ADD CONSTRAINT "VideoProgress_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VideoProgress_videoId_fkey') THEN
    ALTER TABLE "VideoProgress" ADD CONSTRAINT "VideoProgress_videoId_fkey"
      FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- Separate editorial publication from creator-rights clearance. Existing
-- videos fail closed unless their linked creator has explicit permission.
ALTER TABLE "Video"
ADD COLUMN IF NOT EXISTS "rightsStatus" TEXT NOT NULL DEFAULT 'restricted';

UPDATE "Video" AS video
SET "rightsStatus" = 'cleared'
FROM "VideoCreator" AS creator
WHERE video."creatorHandle" = creator."handle"
  AND creator."permissionStatus" = 'yes';

UPDATE "Video" AS video
SET "rightsStatus" = 'revoked'
FROM "VideoCreator" AS creator
WHERE video."creatorHandle" = creator."handle"
  AND creator."permissionStatus" = 'no';

CREATE INDEX IF NOT EXISTS "Video_rightsStatus_published_idx"
ON "Video"("rightsStatus", "published");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Video_rightsStatus_check'
      AND conrelid = '"Video"'::regclass
  ) THEN
    ALTER TABLE "Video" ADD CONSTRAINT "Video_rightsStatus_check"
      CHECK ("rightsStatus" IN ('restricted', 'cleared', 'revoked'));
  END IF;
END
$$;
