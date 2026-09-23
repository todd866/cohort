CREATE TABLE "ExamPaperSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "rotation" TEXT NOT NULL,
  "paper" JSONB NOT NULL,
  "answers" JSONB NOT NULL,
  "flags" TEXT[] NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "submittedAt" TIMESTAMPTZ(3),
  "result" JSONB,
  CONSTRAINT "ExamPaperSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExamPaperSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExamPaperSession_deadline_check" CHECK ("deadlineAt" > "startedAt"),
  CONSTRAINT "ExamPaperSession_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "ExamPaperSession_completion_check" CHECK (("submittedAt" IS NULL) = ("result" IS NULL))
);
CREATE INDEX "ExamPaperSession_userId_startedAt_idx" ON "ExamPaperSession"("userId", "startedAt");
