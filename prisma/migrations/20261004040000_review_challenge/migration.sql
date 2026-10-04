ALTER TABLE "User"
  ADD COLUMN "reviewChallenge" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reviewChallengeRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User" ADD CONSTRAINT "User_reviewChallenge_range"
  CHECK ("reviewChallenge" BETWEEN -2 AND 2);
ALTER TABLE "User" ADD CONSTRAINT "User_reviewChallengeRevision_nonnegative"
  CHECK ("reviewChallengeRevision" >= 0);
