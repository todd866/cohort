-- Marks a learner who told us, in their own words, what they are studying when
-- none of the offered rotations fitted. Read by the review page to stop the
-- chooser re-asking; their description lives in UserFeedback for a human.
ALTER TABLE "User" ADD COLUMN "curriculumRequestedAt" TIMESTAMPTZ(3);
