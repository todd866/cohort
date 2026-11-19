-- Course material for the Anki link: text passages the worker extracts from a learner's uploaded slides, notes
-- and PDFs, searched per learner to ground that learner's checks and drafts.
CREATE TABLE "CourseMaterialPassage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "page" INTEGER,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseMaterialPassage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseMaterialPassage_document_ordinal_key" ON "CourseMaterialPassage"("documentId", "ordinal");
CREATE INDEX "CourseMaterialPassage_user_idx" ON "CourseMaterialPassage"("userId");
-- Full-text search within one learner's passages (the query always filters on "userId" first).
CREATE INDEX "CourseMaterialPassage_text_search_idx" ON "CourseMaterialPassage" USING GIN (to_tsvector('english', "text"));

-- The queue also carries extraction jobs.
ALTER TABLE "AnkiLinkJob" DROP CONSTRAINT "AnkiLinkJob_kind_check";
ALTER TABLE "AnkiLinkJob" ADD CONSTRAINT "AnkiLinkJob_kind_check" CHECK ("kind" IN ('check', 'write', 'extract'));

-- An extraction is queued from the website, not from a paired add-on.
ALTER TABLE "AnkiLinkJob" ALTER COLUMN "peerId" DROP NOT NULL;
