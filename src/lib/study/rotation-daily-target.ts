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
  countCards,
  findManyCards,
  ownerPrivateOrSharedCardScope,
  scopedCardProgressWhere,
} from '@/lib/cards/read-repository.server';

export interface RotationDailyTarget {
  rotation: string;
  dailyTarget: number | null;
  newPerDay: number | null;
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
  const poolFilters = await loadServablePoolFilters(userId);
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { track: true, institution: true },
  });
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
    examDate,
    dueReviews,
    seenCardRows,
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
    getExamDateForUser(rotation, userId),
    prisma.cardProgress.count({
      where: scopedCardProgressWhere(cardScope, {
        userId,
        lastReview: { not: null },
        lastQuality: { lt: 3 },
      }, servableCardWhere),
    }),
    prisma.cardProgress.findMany({
      where: scopedCardProgressWhere(cardScope, { userId, totalReviews: { gt: 0 } }, servableCardWhere),
      select: { cardId: true },
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

  // Self-paced rotations (the AnKing background deck) carry a far-future
  // sentinel so the *scheduler* keeps them near-zero urgency. For the
  // progress display that sentinel means "no deadline" — collapse it to null
  // so daysToExam, dailyTarget, the countdown and the pace nudge all vanish
  // (same shape as USMLE, which has a genuinely null exam date). Without this
  // the sentinel leaks as a literal ~26,800-day countdown and a fabricated
  // daily target/catch-up nudge in the review drawer.
  const effectiveExamDate = isSelfPacedExamDate(examDate) ? null : examDate;

  const daysToExam = effectiveExamDate
    ? Math.max(0, Math.ceil((effectiveExamDate.getTime() - now.getTime()) / DAY_MS))
    : null;

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

  const estimatedDailyReviews = daysToExam && daysToExam > 0
    ? Math.ceil((dueReviews * 2) / daysToExam)
    : 0;

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
    estimatedDailyReviews,
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
    daysToExam,
    examDate: effectiveExamDate?.toISOString() ?? null,
    todayReviewed,
    projection,
    recentHistory,
  };
}
