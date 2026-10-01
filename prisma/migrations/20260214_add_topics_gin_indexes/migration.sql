-- CreateIndex
CREATE INDEX "Card_topics_idx" ON "Card" USING GIN ("topics");

-- CreateIndex
CREATE INDEX "Question_topics_idx" ON "Question" USING GIN ("topics");
