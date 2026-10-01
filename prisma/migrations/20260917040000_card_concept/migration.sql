-- CardConcept: the link cards never had.
--
-- Questions, facts and videos each have a concept join table; cards had none,
-- and "Card"."conceptId" is NOT one — it groups jurisdiction variants of the
-- same card. Additive only: one enum, one table, its indexes.

-- CreateEnum
CREATE TYPE "CardConceptSource" AS ENUM ('authored', 'derived');

-- CreateTable
CREATE TABLE "CardConcept" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "source" "CardConceptSource" NOT NULL DEFAULT 'derived',
    "similarity" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardConcept_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardConcept_cardId_conceptId_key" ON "CardConcept"("cardId", "conceptId");

-- CreateIndex
CREATE INDEX "CardConcept_conceptId_idx" ON "CardConcept"("conceptId");

-- CreateIndex
CREATE INDEX "CardConcept_conceptId_source_idx" ON "CardConcept"("conceptId", "source");

-- AddForeignKey
ALTER TABLE "CardConcept" ADD CONSTRAINT "CardConcept_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardConcept" ADD CONSTRAINT "CardConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;
