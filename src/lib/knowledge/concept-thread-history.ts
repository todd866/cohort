import { prisma } from '@/lib/prisma';
import {
  findManyCards,
  ownerPrivateOrSharedCardScope,
} from '@/lib/cards/read-repository.server';
import {
  CONCEPT_THREAD_MAX_AGE_MS,
  inferClinicalFacet,
  type ClinicalThreadAnchor,
} from './concept-thread-policy';

type SuccessfulThreadEvent = {
  id: string;
  sourceType: string;
  sourceId: string;
  timestamp: Date;
  conceptIds: string[];
};

type ThreadExposure = {
  sourceType: string;
  sourceId: string;
  timestamp: Date;
};

type ThreadQuestion = {
  id: string;
  stem: string;
  topics: string[];
  questionType: string;
  format: string | null;
  variantGroupId: string | null;
};

type ThreadCard = {
  id: string;
  front: string;
  topics: string[];
  variantGroupId: string | null;
};

export interface BuildClinicalThreadAnchorsInput {
  successfulEvents: readonly SuccessfulThreadEvent[];
  exposures: readonly ThreadExposure[];
  questions: readonly ThreadQuestion[];
  cards: readonly ThreadCard[];
  nowMs: number;
  maxAnchors?: number;
}

/**
 * Join successful response events to their immutable-at-selection attribution
 * and current content text. Missing/unknown metadata is omitted rather than
 * guessed into a clinical facet.
 */
export function buildClinicalThreadAnchors(
  input: BuildClinicalThreadAnchorsInput,
): ClinicalThreadAnchor[] {
  const questionById = new Map(input.questions.map(question => [question.id, question]));
  const cardById = new Map(input.cards.map(card => [card.id, card]));
  const maxAnchors = Math.max(0, Math.floor(input.maxAnchors ?? 40));

  const anchors: ClinicalThreadAnchor[] = [];
  const orderedEvents = [...input.successfulEvents].sort((left, right) => (
    right.timestamp.getTime() - left.timestamp.getTime()
    || left.id.localeCompare(right.id)
  ));

  for (const event of orderedEvents) {
    if (anchors.length >= maxAnchors) break;
    const answeredAtMs = event.timestamp.getTime();
    const ageMs = input.nowMs - answeredAtMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CONCEPT_THREAD_MAX_AGE_MS) continue;

    const base = event.sourceType === 'question'
      ? (() => {
          const question = questionById.get(event.sourceId);
          return question
            ? {
                id: question.id,
                itemType: 'question' as const,
                text: question.stem,
                topics: question.topics,
                questionType: question.questionType,
                format: question.format,
                variantGroupId: question.variantGroupId,
              }
            : null;
        })()
      : event.sourceType === 'card'
        ? (() => {
            const card = cardById.get(event.sourceId);
            return card
              ? {
                  id: card.id,
                  itemType: 'card' as const,
                  text: card.front,
                  topics: card.topics,
                  variantGroupId: card.variantGroupId,
                }
              : null;
          })()
        : null;
    if (!base) continue;

    const anchor: ClinicalThreadAnchor = {
      ...base,
      conceptIds: event.conceptIds,
      anchorEventId: event.id,
      answeredAtMs,
      interveningExposures: input.exposures.filter(exposure => (
        exposure.timestamp.getTime() > answeredAtMs
        && exposure.timestamp.getTime() <= input.nowMs
        && !(exposure.sourceType === event.sourceType && exposure.sourceId === event.sourceId)
      )).length,
    };
    if (inferClinicalFacet(anchor) === 'unknown') continue;
    anchors.push(anchor);
  }

  return anchors;
}

/**
 * Load recent successful review anchors for a single scheduler rotation.
 * The query is bounded to the policy horizon and returns only compact text
 * metadata needed by the pure matcher.
 */
export async function loadRecentClinicalThreadAnchors(
  userId: string,
  rotation: string,
  nowMs: number = Date.now(),
): Promise<ClinicalThreadAnchor[]> {
  const since = new Date(nowMs - CONCEPT_THREAD_MAX_AGE_MS);
  const [successfulEvents, exposures] = await Promise.all([
    prisma.learningEvent.findMany({
      where: {
        userId,
        rotation,
        timestamp: { gte: since, lte: new Date(nowMs) },
        origin: { in: ['cohort_web', 'cohort_offline'] },
        OR: [
          {
            eventType: 'mcq_attempted',
            sourceType: 'question',
            isCorrect: true,
          },
          {
            eventType: 'card_reviewed',
            sourceType: 'card',
            quality: { gte: 3 },
          },
        ],
      },
      select: {
        id: true,
        sourceType: true,
        sourceId: true,
        timestamp: true,
        conceptIds: true,
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'asc' }],
      take: 80,
    }),
    prisma.learningEvent.findMany({
      where: {
        userId,
        rotation,
        // Count learner interactions, not every row merely returned in a
        // prefetched batch. Otherwise a single 50-item response would satisfy
        // the cadence before the learner had actually moved through it.
        eventType: { in: ['card_reviewed', 'mcq_attempted'] },
        sourceType: { in: ['card', 'question'] },
        origin: { in: ['cohort_web', 'cohort_offline'] },
        timestamp: { gte: since, lte: new Date(nowMs) },
      },
      select: { sourceType: true, sourceId: true, timestamp: true },
      orderBy: [{ timestamp: 'desc' }],
      // More than this many intervening graded items already exceeds every
      // maturity threshold. A cap prevents pathological history egress while
      // preserving the policy decision.
      take: 2_000,
    }),
  ]);

  if (successfulEvents.length === 0) return [];
  const questionIds = [...new Set(
    successfulEvents.filter(event => event.sourceType === 'question').map(event => event.sourceId),
  )];
  const cardIds = [...new Set(
    successfulEvents.filter(event => event.sourceType === 'card').map(event => event.sourceId),
  )];

  const [questions, cards] = await Promise.all([
    questionIds.length > 0
      ? prisma.question.findMany({
          where: { id: { in: questionIds } },
          select: {
            id: true,
            stem: true,
            topics: true,
            questionType: true,
            format: true,
            variantGroupId: true,
          },
        })
      : Promise.resolve([]),
    cardIds.length > 0
      ? findManyCards(ownerPrivateOrSharedCardScope(userId), {
          where: { id: { in: cardIds } },
          select: {
            id: true,
            front: true,
            topics: true,
            variantGroupId: true,
          },
        })
      : Promise.resolve([]),
  ]);

  return buildClinicalThreadAnchors({
    successfulEvents,
    exposures,
    questions,
    cards,
    nowMs,
  });
}
