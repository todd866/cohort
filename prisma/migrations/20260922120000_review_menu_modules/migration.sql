-- Per-learner review focus menu. Uncustomised accounts keep the shared
-- default (current block + main subject decks).
ALTER TABLE "User" ADD COLUMN "reviewMenuCustomized" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "reviewMenuModules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
