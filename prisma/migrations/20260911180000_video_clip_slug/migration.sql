-- Stable authoring handle for a clip. MDX references a clip by slug rather than
-- by cuid, so a content file can be written before the media exists and a clip
-- can be re-cut without touching every card that points at it.
--
-- Backfilled from the id for any row that predates the column (there are none
-- in production yet; this keeps the NOT NULL honest if that changes).
ALTER TABLE "VideoClip" ADD COLUMN "slug" TEXT;
UPDATE "VideoClip" SET "slug" = "id" WHERE "slug" IS NULL;
ALTER TABLE "VideoClip" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "VideoClip_slug_key" ON "VideoClip"("slug");
