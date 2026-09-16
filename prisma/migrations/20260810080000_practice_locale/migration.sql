-- AlterTable
ALTER TABLE "Card" ADD COLUMN IF NOT EXISTS "practiceLocale" TEXT;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "practiceLocale" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Card_practiceLocale_idx" ON "Card"("practiceLocale");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Question_practiceLocale_idx" ON "Question"("practiceLocale");
