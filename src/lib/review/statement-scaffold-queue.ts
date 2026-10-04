import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { SHARED_CATALOG_CARD_SCOPE, findManyCards } from '@/lib/cards/read-repository.server';
import { EXCLUDED_POOL_TOPICS } from '@/lib/study/servable-pool';
import {
  STATEMENT_SCAFFOLD_MARKER_KEY,
  chooseStatementScaffolds,
  misjudgedStatementFactKeys,
  scaffoldCardsByFactKey,
  statementScaffoldTag,
  withStatementScaffoldMarker,
  type StatementScaffoldMarker,
} from '@/lib/study/statement-scaffolds';

/**
 * Bound on the tagged-card read. One scaffold per statement is the expected
 * shape, and no module's bank is near this; reaching it is logged, not silent.
 */
const SCAFFOLD_SCAN_CAP = 5000;

export interface StatementScaffoldMiss {
  userId: string;
  question: { id: string; rotation: string | null; options: unknown; statements: unknown };
  /** The answer as submitted: a Type X T/F string or a K-type letter. Null is a skip. */
  selectedOption: string | null;
  now: Date;
}

/**
 * After a graded-wrong exam-format answer, make the scaffolds for the misjudged
 * statements due now for this learner, marked so the exam-only session admits
 * them (statement-scaffolds.ts). At most three cards per miss.
 *
 * Background work: the record route runs it in after(). Two bounded reads (the
 * module's tagged cards; this learner's progress on the matches) and one write
 * per chosen card. The due-now write is the one the card-side scaffold queue
 * makes (queueScaffoldingCards in record-card-review.ts), with the marker added.
 * Returns the queued card ids.
 */
export async function queueStatementScaffoldsForMiss(miss: StatementScaffoldMiss): Promise<string[]> {
  const { userId, question, now } = miss;
  const rotation = question.rotation;
  const tag = statementScaffoldTag(rotation);
  if (!rotation || !tag) return [];
  const factKeys = misjudgedStatementFactKeys(question.options, question.statements, miss.selectedOption);
  if (factKeys.length === 0) return [];

  const cards = await findManyCards(SHARED_CATALOG_CARD_SCOPE, {
    where: {
      rotation,
      deletedAt: null,
      shelvedAt: null,
      topics: { has: tag },
      NOT: { topics: { hasSome: [...EXCLUDED_POOL_TOPICS] } },
    },
    select: { id: true, topics: true, variantGroupId: true },
    orderBy: { id: 'asc' },
    take: SCAFFOLD_SCAN_CAP,
  });
  if (cards.length >= SCAFFOLD_SCAN_CAP) {
    logger.warn('Statement scaffold scan reached its cap', { rotation, cap: SCAFFOLD_SCAN_CAP });
  }

  const candidatesByFactKey = scaffoldCardsByFactKey(cards, factKeys);
  const unscaffolded = factKeys.filter((key) => !candidatesByFactKey.has(key));
  if (unscaffolded.length > 0) {
    // Authoring demand, not a serving fault: the reveal screen still taught
    // the statement; there is just no card to follow it up with yet.
    logger.info('Missed statement has no scaffold card', {
      rotation,
      questionId: question.id,
      misjudged: factKeys.length,
      unscaffolded: unscaffolded.length,
      factKeys: unscaffolded,
    });
  }
  const candidateIds = [...new Set([...candidatesByFactKey.values()].flat())];
  if (candidateIds.length === 0) return [];

  const progressRows = await prisma.cardProgress.findMany({
    where: { userId, cardId: { in: candidateIds } },
    select: {
      cardId: true,
      nextDueAt: true,
      totalReviews: true,
      suppressed: true,
      status: true,
      viewsToday: true,
      viewsTodayDate: true,
      reviewContext: true,
    },
  });
  const progressByCardId = new Map(progressRows.map((row) => [row.cardId, row]));
  const chosen = chooseStatementScaffolds({
    factKeys,
    candidatesByFactKey,
    progressByCardId,
    variantGroupByCardId: new Map(cards.map((card) => [card.id, card.variantGroupId ?? null])),
    now,
    seed: `${userId}:${question.id}:${now.toISOString()}`,
  });
  if (chosen.length === 0) return [];

  const marker = (reviewsAtQueue: number): StatementScaffoldMarker => ({
    queuedAt: now.toISOString(),
    rotation,
    questionId: question.id,
    reviewsAtQueue,
  });
  const fresh = chosen.filter((cardId) => !progressByCardId.has(cardId));
  const seen = chosen.filter((cardId) => progressByCardId.has(cardId));

  if (fresh.length > 0) {
    // skipDuplicates: a row created meanwhile keeps its own state and no marker,
    // so that card is simply not served from this miss.
    await prisma.cardProgress.createMany({
      data: fresh.map((cardId) => ({
        userId,
        cardId,
        nextDueAt: now,
        reviewContext: { [STATEMENT_SCAFFOLD_MARKER_KEY]: marker(0) } as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }
  await Promise.all(seen.map((cardId) => {
    const row = progressByCardId.get(cardId)!;
    return prisma.cardProgress.updateMany({
      // totalReviews pins the row to what was read. A review landing in between
      // updates nothing here, rather than re-arming a card just reviewed.
      where: { userId, cardId, totalReviews: row.totalReviews, suppressed: false, status: { not: 'retired' } },
      data: {
        nextDueAt: now,
        reviewContext: withStatementScaffoldMarker(
          row.reviewContext,
          marker(row.totalReviews),
        ) as unknown as Prisma.InputJsonValue,
      },
    });
  }));

  logger.info('Queued statement scaffolds', {
    rotation,
    questionId: question.id,
    misjudged: factKeys.length,
    queued: chosen.length,
  });
  return chosen;
}
