ALTER TABLE "UserDocument" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'document';
ALTER TABLE "UserDocument" ADD COLUMN "flagIssueId" TEXT;
CREATE UNIQUE INDEX "UserDocument_flagIssueId_key" ON "UserDocument"("flagIssueId");
ALTER TABLE "UserDocument" ADD CONSTRAINT "UserDocument_flagIssueId_fkey" FOREIGN KEY ("flagIssueId") REFERENCES "ContentIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
