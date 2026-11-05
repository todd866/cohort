-- Default review-menu decks a learner had been offered at their last menu save (BACKLOG 0t).
ALTER TABLE "User" ADD COLUMN "reviewMenuKnownDecks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
