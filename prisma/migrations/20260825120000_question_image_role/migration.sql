-- Additive prompt-image contract for question-bank items. Existing rows remain
-- after-reveal/optional because NULL is the only backwards-compatible default.
ALTER TABLE "Question" ADD COLUMN "imageRole" TEXT;

ALTER TABLE "Question"
  ADD CONSTRAINT "Question_imageRole_check"
  CHECK ("imageRole" IS NULL OR "imageRole" = 'prompt');
