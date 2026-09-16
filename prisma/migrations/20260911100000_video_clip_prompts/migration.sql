-- Operative video clips served as card/question stems.
--
-- Additive throughout: every new column is nullable or defaulted, so existing
-- rows keep their current behaviour. Rights default to 'restricted' so a source
-- row created by the discovery script serves to nobody until a human clears it.

CREATE TABLE "VideoSource" (
  "id"                TEXT NOT NULL,
  "url"               TEXT NOT NULL,
  "externalId"        TEXT NOT NULL,
  "platform"          TEXT NOT NULL DEFAULT 'youtube',
  "title"             TEXT NOT NULL,
  "channelName"       TEXT,
  "channelUrl"        TEXT,
  "durationSecs"      INTEGER NOT NULL DEFAULT 0,
  "licence"           TEXT,
  "rightsStatus"      TEXT NOT NULL DEFAULT 'restricted',
  "rightsNotes"       TEXT,
  "chapters"          JSONB,
  "heatmap"           JSONB,
  "metadataFetchedAt" TIMESTAMPTZ(3),
  "createdAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "VideoSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VideoSource_url_key" ON "VideoSource"("url");
CREATE UNIQUE INDEX "VideoSource_externalId_key" ON "VideoSource"("externalId");
CREATE INDEX "VideoSource_rightsStatus_idx" ON "VideoSource"("rightsStatus");
CREATE INDEX "VideoSource_platform_idx" ON "VideoSource"("platform");

ALTER TABLE "VideoSource"
  ADD CONSTRAINT "VideoSource_rightsStatus_check"
  CHECK ("rightsStatus" IN ('restricted', 'cleared', 'revoked'));

CREATE TABLE "VideoClip" (
  "id"               TEXT NOT NULL,
  "sourceId"         TEXT NOT NULL,
  "startSecs"        DOUBLE PRECISION NOT NULL,
  "endSecs"          DOUBLE PRECISION NOT NULL,
  "r2Key"            TEXT NOT NULL,
  "posterR2Key"      TEXT,
  "audioStripped"    BOOLEAN NOT NULL DEFAULT true,
  "windowTranscript" TEXT,
  "clipKind"         TEXT NOT NULL,
  "label"            TEXT,
  "createdAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"        TIMESTAMPTZ(3),
  CONSTRAINT "VideoClip_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VideoClip_r2Key_key" ON "VideoClip"("r2Key");
CREATE INDEX "VideoClip_sourceId_idx" ON "VideoClip"("sourceId");
CREATE INDEX "VideoClip_clipKind_idx" ON "VideoClip"("clipKind");

ALTER TABLE "VideoClip"
  ADD CONSTRAINT "VideoClip_sourceId_fkey" FOREIGN KEY ("sourceId")
  REFERENCES "VideoSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "VideoClip"
  ADD CONSTRAINT "VideoClip_clipKind_check"
  CHECK ("clipKind" IN ('next-step', 'anatomy-motion', 'instrument-id'));

-- A window must be a real forward window. Belt and braces against a bad
-- discovery run writing start >= end, which would produce a zero-length cut.
ALTER TABLE "VideoClip"
  ADD CONSTRAINT "VideoClip_window_check"
  CHECK ("startSecs" >= 0 AND "endSecs" > "startSecs");

ALTER TABLE "Card"     ADD COLUMN "clipId" TEXT;
ALTER TABLE "Card"     ADD COLUMN "clipRole" TEXT;
ALTER TABLE "Card"     ADD COLUMN "clipCaption" TEXT;
ALTER TABLE "Question" ADD COLUMN "clipId" TEXT;
ALTER TABLE "Question" ADD COLUMN "clipRole" TEXT;
ALTER TABLE "Question" ADD COLUMN "clipCaption" TEXT;

CREATE INDEX "Card_clipId_idx"     ON "Card"("clipId");
CREATE INDEX "Question_clipId_idx" ON "Question"("clipId");

ALTER TABLE "Card"
  ADD CONSTRAINT "Card_clipId_fkey" FOREIGN KEY ("clipId")
  REFERENCES "VideoClip"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE "Question"
  ADD CONSTRAINT "Question_clipId_fkey" FOREIGN KEY ("clipId")
  REFERENCES "VideoClip"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "Card"
  ADD CONSTRAINT "Card_clipRole_check"
  CHECK ("clipRole" IS NULL OR "clipRole" = 'prompt');
ALTER TABLE "Question"
  ADD CONSTRAINT "Question_clipRole_check"
  CHECK ("clipRole" IS NULL OR "clipRole" = 'prompt');
