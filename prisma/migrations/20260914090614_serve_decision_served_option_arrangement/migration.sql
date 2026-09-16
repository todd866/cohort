-- Record the option arrangement the learner was SERVED, not just the one they answered.
--
-- QuestionResponse.correctDisplayPosition exists only once an item is answered,
-- so a question shown and skipped left no trace of where its answer sat. Both
-- columns are nullable: every pre-existing row, every card and every video
-- legitimately has no arrangement.
ALTER TABLE "ServeDecision" ADD COLUMN "servedCorrectPosition" INTEGER;
ALTER TABLE "ServeDecision" ADD COLUMN "servedOptionCount" INTEGER;
