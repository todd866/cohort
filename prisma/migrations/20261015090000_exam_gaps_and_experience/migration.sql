-- Exam gaps: learners record the official per-area feedback of an exam they
-- sat, beside md3's own accuracy in the same blueprint areas. Additive only.
ALTER TABLE "ExamResult" ADD COLUMN "correct" INTEGER;
ALTER TABLE "ExamResult" ADD COLUMN "total" INTEGER;
ALTER TABLE "ExamResult" ADD COLUMN "areas" JSONB;
ALTER TABLE "ExamResult" ADD COLUMN "recalled" TEXT;
ALTER TABLE "ExamResult" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'script';
ALTER TABLE "ExamResult" ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Learner-chosen experience settings (statistics layout today; the learner
-- shaping knobs later share the same column).
ALTER TABLE "User" ADD COLUMN "experience" JSONB;
