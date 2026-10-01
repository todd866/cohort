-- Opt-in leaderboard: a learner who joins picks a handle and becomes visible to
-- other joined learners; nobody else sees the board. Both columns null until
-- the learner joins; leaving nulls joinedAt and keeps the handle reserved.
ALTER TABLE "User" ADD COLUMN "leaderboardHandle" TEXT;
ALTER TABLE "User" ADD COLUMN "leaderboardJoinedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "User_leaderboardHandle_key" ON "User"("leaderboardHandle");
