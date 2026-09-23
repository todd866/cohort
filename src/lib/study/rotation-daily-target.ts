/**
 * Per-rotation daily-target compute, factored out of /api/study/daily-target.
 *
 * The endpoint accepts one OR many rotations; this helper does the work for
 * a single rotation and the route assembles them in parallel.
 */

import { computeTopicCoverage } from './topic-coverage';
import { prisma } from '@/lib/prisma';
import { getExamDateForUser, isSelfPacedExamDate } from '@/lib/rotations';
import {
  getBlockExamDate,
  getBlockStartDate,
  type TrackNumber,
} from '@/lib/rotation-context';
import { attributedRotation } from '@/lib/study/review-attribution';
import { computeDailyTarget, readinessSignal, type DailyTargetResult } from './daily-target';
import { computeTrackProjection, type TrackProjection } from './track-projection';
import {
  buildDistinctDailyHistory,
  toFirstSeenEvents,
  type StudyEvent,
} from './track-projection-validation';
import {
  buildServableCardWhere,
  buildServableQuestionWhere,
  loadServablePoolFilters,
} from './servable-pool';
import { resolvePracticeLocale } from './practice-locale';
import {
  buildProgressPoolBands,
  daysUntilCalendarExam,
  learnedCardProgressFilter,
  progressHorizonDays,
  shakyCardProgressFilter,
} from './progress-pool';
import {
  countCards,
  findManyCards,
  ownerPrivateOrSharedCardScope,
  scopedCardProgressWhere,
} from '@/lib/cards/read-repository.server';

export interface RotationDailyTarget {
  rotation: string;
  dailyTarget: number | null;
  newPerDay: number | null;
  firstSightTarget: number | null;
  todayFirstSight: number;
  reviewsPerDay: number | null;
  learningFactor: number | null;
  consolidationDays: number | null;
  adaptiveReason: DailyTargetResult['adaptiveReason'] | null;
  coverage: {
    seen: number;
    total: number;
    percent: number;
    seenCards: number;
    totalCards: number;
    seenQuestions: number;
    totalQuestions: number;
    /** Topics (clusters) the learner has met, and topics with live cards. `percent` is derived from these. */
    coveredTopics: number;
    totalTopics: number;
    /** The old seen-items share, kept as a secondary figure; it falls whenever content is added. */
    itemPercent: number;
  };
  progressPool: ReturnType<typeof buildProgressPoolBands>;
  progressPoolHorizonDays: number;
  selfPaced: boolean;
  daysToExam: number | null;
  examDate: string | null;
  todayReviewed: number;
  projection: TrackProjection | null;
  /** 14-day activity bucketed by study day (index 0 = today). */
  recentHistory: number[];
}

const HISTORY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function computeRotationDailyTarget(
  userId: string,
  rotation: string,
  startOfDay: Date,
  now: Date = new Date(),
): Promise<RotationDailyTarget> {
  const windowStart = new Date(startOfDay.getTime() - (HISTORY_DAYS - 1) * DAY_MS);
  const [poolFilters, userRow, examDate] = await Promise.all([
    loadServablePoolFilters(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: { track: true, institution: true },
    }),
    getExamDateForUser(rotation, userId),
  ]);
  // Self-paced rotations carry a far-future sentinel for scheduler urgency;
  // the display treats it as no deadline and uses a 21-day holding horizon.
  // A sitting that has already passed is not a countdown either. Clamping it
  // to 0 made a finished block sort ahead of the real exam ("0 days to exam").
  const scheduledExamDate = examDate && !isSelfPacedExamDate(examDate) ? examDate : null;
  const rawDays = scheduledExamDate ? daysUntilCalendarExam(scheduledExamDate, now) : null;
  const examStillOpen = rawDays != null && rawDays >= 0;
  const daysToExam = examStillOpen ? rawDays : null;
  const effectiveExamDate = examStillOpen ? scheduledExamDate : null;
  const progressPoolHorizonDays = progressHorizonDays(daysToExam);
  const practiceLocale = resolvePracticeLocale({
    institution: userRow?.institution,
    requestRotation: rotation,
  });
  const servableCardWhere = buildServableCardWhere({
    rotation,
    week: null,
    openIssueCardIds: poolFilters.openIssueCardIds,
    practiceLocale,
  });
  const servableQuestionWhere = buildServableQuestionWhere({
    rotation,
    week: null,
    openIssueQuestionIds: poolFilters.openIssueQuestionIds,
    globallyExcludedQuestionIds: poolFilters.globallyExcludedQuestionIds,
    allowPrivateSources: poolFilters.allowPrivateSources,
    practiceLocale,
  });
  const cardScope = ownerPrivateOrSharedCardScope(userId);

  const [
    cardRows,
    totalCards,
    totalQuestions,
    seenCards,
    seenQuestionRows,
    dueReviews,
    seenCardRows,
    learnedCards,
    shakyCards,
  ] = await Promise.all([
    findManyCards(cardScope, {
      where: servableCardWhere,
      select: { id: true, clusterId: true },
    }),
    countCards(cardScope, { where: servableCardWhere }),
    prisma.question.count({ where: servableQuestionWhere }),
    prisma.cardProgress.count({
      where: scopedCardProgressWhere(
        cardScope,
        { userId, totalReviews: { gt: 0 } },
        servableCardWhere,
      ),
    }),
    prisma.questionResponse.findMany({
      where: { userId, question: servableQuestionWhere },
      select: { questionId: true },
      distinct: ['questionId'],
    }),
    prisma.cardProgress.count({
      where: scopedCardProgressWhere(cardScope, {
        userId,
        totalReviews: { gt: 0 },
        suppressed: false,
        flagged: false,
        status: { notIn: ['retired'] },
        nextDueAt: { lte: now },
      }, servableCardWhere),
    }),
    prisma.cardProgress.findMany({
      where: scopedCardProgressWhere(cardScope, { userId, totalReviews: { gt: 0 } }, servableCardWhere),
      select: { cardId: true },
    }),
    prisma.cardProgress.count({
      where: scopedCardProgressWhere(cardScope, {
        userId,
        ...learnedCardProgressFilter,
      }, servableCardWhere),
    }),
    prisma.cardProgress.count({
      where: scopedCardProgressWhere(cardScope, {
        userId,
        ...shakyCardProgressFilter,
      }, servableCardWhere),
    }),
  ]);

  // Topic coverage: a topic is met once a handful of its cards are seen, so
  // authoring more cards into a known topic never moves a learner backwards.
  // Questions carry no cluster, so topics are read from cards alone.
  const seenCardIds = new Set(seenCardRows.map((r) => r.cardId));
  const clusterTotals = new Map<string, { items: number; seen: number }>();
  for (const card of cardRows) {
    if (!card.clusterId) continue;
    const row = clusterTotals.get(card.clusterId) ?? { items: 0, seen: 0 };
    row.items += 1;
    if (seenCardIds.has(card.id)) row.seen += 1;
    clusterTotals.set(card.clusterId, row);
  }
  const topics = computeTopicCoverage(
    [...clusterTotals.entries()].map(([clusterId, row]) => ({ clusterId, ...row })),
  );

  const seenQuestions = seenQuestionRows.length;
  const totalSeen = seenCards + seenQuestions;
  const totalItems = totalCards + totalQuestions;
  const unseenItems = totalItems - totalSeen;

  // These counts power the drawer's knowledge bar. They are intentionally
  // separate from `dueReviews`, which is a workload estimate and must never
  // be painted as "shaky". A card due again was recalled; that is the review
  // queue, not a failure. Learned is the last successful recall. Shaky is
  // the last failed one.
  const progressPool = buildProgressPoolBands({
    totalCards,
    totalQuestions,
    seenCards,
    seenQuestions: seenQuestionRows.length,
    learnedCards: learnedCards > seenCards ? seenCards : learnedCards,
    shakyCards,
  });

  const track = Number.isInteger(userRow?.track)
    && userRow!.track! >= 1
    && userRow!.track! <= 4
    ? userRow!.track as TrackNumber
    : null;
  const blockStart = track ? getBlockStartDate(rotation, track) : null;
  const blockExam = track ? getBlockExamDate(rotation, track) : null;
  const termLengthDays = blockStart && blockExam && blockExam.getTime() > blockStart.getTime()
    ? Math.max(1, Math.ceil((blockExam.getTime() - blockStart.getTime()) / DAY_MS))
    : null;

  const nativeCardIds = cardRows.map((c) => c.id);
  const nativeCardIdSet = new Set(nativeCardIds);
  const cardIds = nativeCardIds;

  const [
    activityCardEvents,
    activityQuestionEvents,
    projectionCardEventGroups,
    projectionCardFallbackRows,
    projectionQuestionGroups,
    recentMcqEvents,
  ] = await Promise.all([
    prisma.learningEvent.findMany({
      // No card-id prefilter: a composed deck serves cards it does not own
      // (NSx borrows the plates and BlueLink; before 2026-09-16 it owned
      // nothing at all), so filtering by the rotation's own corpus would drop
      // them. Which deck each review belongs to is decided below, per review.
      // Index-backed on (userId, timestamp).
      where: {
        userId,
        eventType: 'card_reviewed',
        sourceType: 'card',
        timestamp: { gte: windowStart },
      },
      select: { timestamp: true, sourceId: true, metadata: true },
    }),
    prisma.questionResponse.findMany({
      where: { userId, question: servableQuestionWhere, createdAt: { gte: windowStart } },
      select: { createdAt: true },
    }),
    prisma.learningEvent.groupBy({
      by: ['sourceId'],
      where: {
        userId,
        eventType: 'card_reviewed',
        sourceType: 'card',
        sourceId: { in: cardIds },
      },
      _min: { timestamp: true },
    }),
    prisma.cardProgress.findMany({
      where: scopedCardProgressWhere(cardScope, {
        userId,
        totalReviews: 1,
        lastReview: { gte: windowStart },
      }, servableCardWhere),
      select: { cardId: true, lastReview: true },
    }),
    prisma.questionResponse.groupBy({
      by: ['questionId'],
      where: { userId, question: servableQuestionWhere },
      _min: { createdAt: true },
    }),
    // Recent rotation MCQ answers — drives the readiness pressure (accuracy)
    // and its trust weight (response-time engagement signature).
    prisma.learningEvent.findMany({
      where: { userId, rotation, eventType: 'mcq_attempted', timestamp: { gte: windowStart } },
      select: { isCorrect: true, responseMs: true },
    }),
  ]);

  const projectionCardEventRows = projectionCardEventGroups
    .filter((row) => row._min.timestamp && row._min.timestamp >= windowStart)
    .map((row) => ({ sourceId: row.sourceId, timestamp: row._min.timestamp! }));
  const projectionQuestionRows = projectionQuestionGroups
    .filter((row) => row._min.createdAt && row._min.createdAt >= windowStart)
    .map((row) => ({ questionId: row.questionId, createdAt: row._min.createdAt! }));

  const recentHistory = new Array(HISTORY_DAYS).fill(0);
  const bucket = (t: Date | null) => {
    if (!t) return -1;
    const diffDays = Math.floor((startOfDay.getTime() - t.getTime()) / DAY_MS);
    if (t.getTime() >= startOfDay.getTime()) return 0;
    const idx = diffDays + 1;
    return idx >= 0 && idx < HISTORY_DAYS ? idx : -1;
  };
  for (const r of activityCardEvents) {
    const i = bucket(r.timestamp);
    if (i < 0) continue;
    const meta = r.metadata;
    const served = meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).servedRotation
      : undefined;
    const attributed = attributedRotation({
      servedRotation: typeof served === 'string' ? served : null,
      owningRotation: nativeCardIdSet.has(r.sourceId) ? rotation : null,
    });
    if (attributed === rotation) recentHistory[i]++;
  }
  for (const r of activityQuestionEvents) {
    const i = bucket(r.createdAt);
    if (i >= 0) recentHistory[i]++;
  }
  const todayReviewed = recentHistory[0] ?? 0;

  const firstSeenEvents: StudyEvent[] = [
    ...projectionCardEventRows.map((row) => ({
      itemId: `card:${row.sourceId}`,
      occurredAt: row.timestamp,
    })),
    ...projectionCardFallbackRows
      .filter((row) => row.lastReview)
      .map((row) => ({
        itemId: `card:${row.cardId}`,
        occurredAt: row.lastReview!,
      })),
    ...projectionQuestionRows.map((row) => ({
      itemId: `question:${row.questionId}`,
      occurredAt: row.createdAt,
    })),
  ];
  const firstSeenHistory = buildDistinctDailyHistory({
    events: toFirstSeenEvents(firstSeenEvents),
    asOf: startOfDay,
    completedLookbackDays: HISTORY_DAYS - 1,
  });

  // Readiness signal: recent rotation MCQ accuracy + how genuinely it was
  // tested. readinessSignal() guards both sample sizes (accuracy needs enough
  // answers; trust needs enough *timed* answers) so a sparse window can't
  // over-prescribe. Both null/0 ⇒ readiness is a no-op.
  const { currentAccuracy, signalTrust } = readinessSignal(recentMcqEvents);

  const result = computeDailyTarget({
    unseenItems,
    daysToExam,
    termLengthDays,
    actualDueItems: dueReviews,
    recentHistory,
    currentAccuracy,
    signalTrust,
  });

  const projection = computeTrackProjection({
    totalItems,
    seenItems: totalSeen,
    daysToExam,
    consolidationDays: result?.consolidationDays ?? null,
    recentFirstSeenHistory: firstSeenHistory,
    recentTotalHistory: recentHistory,
    dailyTarget: result?.dailyTarget ?? null,
    todayNewItems: firstSeenHistory[0] ?? 0,
    todayTotalItems: todayReviewed,
  });

  return {
    rotation,
    dailyTarget: result?.dailyTarget ?? null,
    newPerDay: result?.newPerDay ?? null,
    firstSightTarget: result?.firstSightTarget ?? null,
    todayFirstSight: firstSeenHistory[0] ?? 0,
    reviewsPerDay: result?.reviewsPerDay ?? null,
    learningFactor: result?.learningFactor ?? null,
    consolidationDays: result?.consolidationDays ?? null,
    adaptiveReason: result?.adaptiveReason ?? null,
    coverage: {
      seen: totalSeen,
      total: totalItems,
      percent: topics.totalTopics > 0
        ? topics.percent
        : (totalItems > 0 ? Math.floor((totalSeen / totalItems) * 100) : 0),
      itemPercent: totalItems > 0 ? Math.floor((totalSeen / totalItems) * 100) : 0,
      coveredTopics: topics.coveredTopics,
      totalTopics: topics.totalTopics,
      seenCards,
      totalCards,
      seenQuestions,
      totalQuestions,
    },
    progressPool,
    progressPoolHorizonDays,
    selfPaced: daysToExam == null,
    daysToExam,
    examDate: effectiveExamDate?.toISOString() ?? null,
    todayReviewed,
    projection,
    recentHistory,
  };
}
