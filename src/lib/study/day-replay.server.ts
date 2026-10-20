/**
 * A review session made of exactly the cards and questions this learner
 * answered on the given Sydney days, or the cards due then.
 *
 * One indexed read of their own events (or their own due rows), then a
 * primary-key load of those items. It does not consult anyone else's history
 * and it is not on the ordinary review hot path.
 *
 * An item is served only when ordinary review would serve it today: the same
 * card-ownership scope, question serving policy, pool exclusions, copyright
 * prompt gate, and rotation entitlement (personal, supplementary, guests).
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { findManyCards, ownerPrivateOrSharedCardScope } from '@/lib/cards/read-repository.server';
import { isUsableQuestion } from '@/lib/question-validation';
import { withDefaultQuestionServingPolicy } from '@/lib/questions/source-policy';
import { isPersonalRotation, viewerCanAccessRequestedRotations } from '@/lib/personal-rotation-access';
import { isExamCrossSourceRotation } from '@/lib/cross-source-rotations';
import { isSupplementaryRotation } from '@/lib/supplementary-rotations';
import { withoutRawPublicUsmleQuestions } from '@/lib/usmle/raw-question-boundary';
import type { ReviewItem } from '@/components/review/hooks/types';
import type { AccessTier } from '@/lib/images/types';
import { resolvePracticeLocale } from '@/lib/study/practice-locale';
import { hydrateScheduledItems, loadScheduledItemHydrationData } from '@/lib/study/unified-session-hydration';
import { sydneyDayEndSql, sydneyDayStartSql } from '@/lib/stats/stats-query.server';
import {
  EXCLUDED_POOL_TOPICS,
  clipPromptCardWhere,
  clipPromptQuestionWhere,
  imagePromptCardWhere,
  loadServablePoolFilters,
} from '@/lib/study/servable-pool';

export type DayReplayDb = Pick<PrismaClient, '$queryRaw' | 'card' | 'question' | 'user' | 'cardProgress'>;

const REVIEW_TYPES = ['card_reviewed', 'mcq_attempted'];
const ITEM_CAP = 300;

interface IdRow { sourceType: string; sourceId: string }

interface ReplayViewer {
  isGuest: boolean;
  emails: readonly (string | null | undefined)[];
  imageTier: string | null;
  activeModules: readonly string[];
}

async function answeredIds(db: DayReplayDb, userId: string, from: string, to: string): Promise<IdRow[]> {
  return db.$queryRaw<IdRow[]>(Prisma.sql`
    SELECT "sourceType", "sourceId"
    FROM "LearningEvent"
    WHERE "userId" = ${userId}
      AND "eventType" = ANY(${REVIEW_TYPES}::text[])
      AND "sourceType" IN ('card', 'question')
      AND "timestamp" >= ${sydneyDayStartSql(from)}
      AND "timestamp" < ${sydneyDayEndSql(to)}
    GROUP BY 1, 2
    ORDER BY MIN("timestamp")
    LIMIT ${ITEM_CAP}
  `);
}

async function dueIds(db: DayReplayDb, userId: string, from: string, to: string): Promise<IdRow[]> {
  const rows = await db.$queryRaw<Array<{ sourceId: string }>>(Prisma.sql`
    SELECT cp."cardId" AS "sourceId"
    FROM "CardProgress" cp
    WHERE cp."userId" = ${userId}
      AND cp.status <> 'retired'
      AND NOT cp.suppressed
      AND cp."nextDueAt" >= ${sydneyDayStartSql(from)}
      AND cp."nextDueAt" < ${sydneyDayEndSql(to)}
    ORDER BY cp."nextDueAt"
    LIMIT ${ITEM_CAP}
  `);
  return rows.map((row) => ({ sourceType: 'card', sourceId: row.sourceId }));
}

/**
 * The rotation gate on `/api/study/unified-session`: guests get scheduled
 * rotations only; personal decks need the owner (or shared tier) and
 * enrolment; supplementary and exam-support sources need enrolment.
 */
export function replayRotationAllowed(rotation: string, viewer: ReplayViewer): boolean {
  if (!rotation) return false;
  if (isPersonalRotation(rotation)) {
    if (viewer.isGuest || !viewer.activeModules.includes(rotation)) return false;
    return viewerCanAccessRequestedRotations([rotation], {
      emails: viewer.emails,
      imageTier: viewer.imageTier,
    });
  }
  if (isSupplementaryRotation(rotation) || isExamCrossSourceRotation(rotation)) {
    return !viewer.isGuest && viewer.activeModules.includes(rotation);
  }
  return true;
}

export async function loadDayReplayItems(
  db: DayReplayDb,
  userId: string,
  from: string,
  to: string,
  mode: 'answered' | 'due',
  hydrate: ReplayHydrator = hydrateReplayItems,
): Promise<ReviewItem[]> {
  const ids = mode === 'due' ? await dueIds(db, userId, from, to) : await answeredIds(db, userId, from, to);
  if (ids.length === 0) return [];
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      imageTier: true,
      activeModules: true,
      institution: true,
      emailAliases: {
        where: { verified: true },
        select: { email: true },
      },
    },
  });
  if (!user) return [];
  const viewer: ReplayViewer = {
    isGuest: !user.email,
    emails: [user.email, ...(user.emailAliases ?? []).map((alias) => alias.email)],
    imageTier: user.imageTier ?? null,
    activeModules: user.activeModules ?? [],
  };
  const isCopyright = viewer.imageTier === 'copyright';
  const filters = await loadServablePoolFilters(userId);
  const cardIds = ids.filter((row) => row.sourceType === 'card').map((row) => row.sourceId);
  const questionIds = ids.filter((row) => row.sourceType === 'question').map((row) => row.sourceId);
  const blockedProgress = cardIds.length
    ? await db.cardProgress.findMany({
      where: {
        userId,
        cardId: { in: cardIds },
        OR: [
          { suppressed: true },
          { flagged: true },
          { status: 'retired' },
          { leechSuppressedUntil: { gt: new Date() } },
        ],
      },
      select: { cardId: true },
    })
    : [];
  const blockedCardIds = new Set(blockedProgress.map((row) => row.cardId));
  const servableCardIds = cardIds.filter((id) => !blockedCardIds.has(id) && !filters.openIssueCardIds.has(id));
  const excludedQuestionIds = new Set<string>([
    ...filters.openIssueQuestionIds,
    ...filters.globallyExcludedQuestionIds,
  ]);
  const servableQuestionIds = questionIds.filter((id) => !excludedQuestionIds.has(id));

  const [cards, questions] = await Promise.all([
    servableCardIds.length
      ? findManyCards(ownerPrivateOrSharedCardScope(userId), {
        where: {
          AND: [
            { id: { in: servableCardIds } },
            { deletedAt: null },
            { shelvedAt: null },
            { NOT: { topics: { hasSome: [...EXCLUDED_POOL_TOPICS] } } },
            imagePromptCardWhere(isCopyright),
            clipPromptCardWhere(isCopyright),
          ],
        },
        select: {
          id: true, front: true, back: true, backs: true, context: true, rotation: true,
          week: true, topics: true, difficulty: true, imageUrl: true, imageCaption: true,
          imageRole: true, abbreviations: true, sourceComponent: true, complexity: true,
        },
      }, db.card)
      : [],
    servableQuestionIds.length
      ? db.question.findMany({
        where: withDefaultQuestionServingPolicy(
          withoutRawPublicUsmleQuestions({
            AND: [
              { id: { in: servableQuestionIds } },
              { excluded: false },
              { NOT: { topics: { hasSome: [...EXCLUDED_POOL_TOPICS] } } },
              imagePromptCardWhere(isCopyright) as Prisma.QuestionWhereInput,
              clipPromptQuestionWhere(isCopyright),
            ],
          }),
          { allowPrivateSources: filters.allowPrivateSources },
        ),
        select: {
          id: true, stem: true, options: true, combinations: true, correctVariants: true,
          context: true, rotation: true, week: true, topics: true, difficulty: true,
          imageUrl: true, imageCaption: true, imageRole: true, abbreviations: true,
        },
      })
      : [],
  ]);
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const eligible: ReplayEligible[] = [];
  for (const row of ids) {
    if (row.sourceType === 'card') {
      const card = cardById.get(row.sourceId);
      if (card && replayRotationAllowed(card.rotation, viewer)) eligible.push({ type: 'card', id: card.id, rotation: card.rotation });
      continue;
    }
    const question = questionById.get(row.sourceId);
    if (!question || !Array.isArray(question.options) || !replayRotationAllowed(question.rotation, viewer)) continue;
    if (!isUsableQuestion({ options: question.options, context: question.context, topics: question.topics })) continue;
    eligible.push({ type: 'question', id: question.id, rotation: question.rotation });
  }
  if (eligible.length === 0) return [];
  const trust: AccessTier = viewer.imageTier === 'copyright'
    ? 'copyright-required'
    : viewer.isGuest ? 'public' : 'auth-required';
  return hydrate(eligible, { userId, institution: user.institution ?? null, trust });
}

export interface ReplayEligible { type: 'card' | 'question'; id: string; rotation: string }
export type ReplayHydrator = (
  eligible: ReplayEligible[],
  viewer: { userId: string; institution: string | null; trust: AccessTier },
) => Promise<ReviewItem[]>;

/**
 * Builds replay items with the same hydration ordinary review uses, per
 * rotation: current content, image and clip resolution with the learner's
 * tier, prompt items dropped when their figure or clip cannot be delivered,
 * and the attempt-aware option order. Order follows the day's first answers.
 */
export const hydrateReplayItems: ReplayHydrator = async (eligible, viewer) => {
  const byRotation = new Map<string, ReplayEligible[]>();
  for (const item of eligible) byRotation.set(item.rotation, [...(byRotation.get(item.rotation) ?? []), item]);
  const hydrated = new Map<string, ReviewItem>();
  for (const [rotation, items] of byRotation) {
    const scheduledItems = items.map((item) => ({
      type: item.type,
      id: item.id,
      priority: 1,
      conceptId: '',
      conceptName: '',
      interventionReason: 'reinforcement' as const,
    }));
    const hydrationData = await loadScheduledItemHydrationData({
      userId: viewer.userId,
      scheduledItems,
      deliveryContext: {
        userId: viewer.userId,
        rotation,
        practiceLocale: resolvePracticeLocale({ institution: viewer.institution, requestRotation: rotation }),
        weekFilter: null,
        crossSourceRotations: [],
        crossSourceMappingMode: 'adjacent',
      },
    });
    const out = await hydrateScheduledItems(scheduledItems, hydrationData, { rotation }, null, viewer.trust);
    for (const item of out) hydrated.set(`${item.type}:${item.id}`, item as unknown as ReviewItem);
  }
  return eligible.flatMap((item) => hydrated.get(`${item.type}:${item.id}`) ?? []);
};
