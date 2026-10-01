-- Additive: statement-item metadata for exam-format items (GSSE Type X, NSA
-- Type 1/2). NULL for every existing row; ordinary questions never set it.
ALTER TABLE "Question" ADD COLUMN "statements" JSONB;
