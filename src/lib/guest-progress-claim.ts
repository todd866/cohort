import 'server-only';

import type {
  CardProgress,
  ConceptState,
  DailyStats,
  Prisma,
  UserClusterState,
  VideoProgress,
} from '@prisma/client';
import { Prisma as PrismaRuntime } from '@prisma/client';
import { clearGuestUserCookie, readGuestUserCookie } from '@/lib/guest-user';
import {
  isRetryableReviewTransactionError,
  SERIALIZABLE_REVIEW_TRANSACTION,
} from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { calculateStreakFromDailyStats } from '@/lib/stats';

type ClaimNotEligibleReason =
  | 'cookie-missing'
  | 'authenticated-user-missing'
  | 'guest-missing'
  | 'guest-not-anonymous'
  | 'same-user';

export interface GuestClaimCounts {
  cardProgress: number;
  questionResponses: number;
  learningEvents: number;
  dailyStats: number;
  studyQueues: number;
  syncOperations: number;
  conceptStates: number;
  clusterStates: number;
  struggleRegions: number;
  videoProgress: number;
  reviewSessions: number;
  assessmentAttempts: number;
  contentExposures: number;
  serveDecisions: number;
  struggleInterventions: number;
  teachingSignals: number;
  deepDiveChatSessions: number;
  deepDiveChatMessages: number;
}

export type GuestProgressClaimResult =
  | { status: 'claimed'; counts: GuestClaimCounts }
  | { status: 'nothing-to-claim'; counts: GuestClaimCounts }
  | { status: 'not-eligible'; reason: ClaimNotEligibleReason }
  | { status: 'failed' };

const MAX_POSTGRES_INT = 2_147_483_647;
const GUEST_CLAIM_MAX_WAIT_MS = 1_000;
const GUEST_CLAIM_TIMEOUT_MS = 4_000;
const BULK_MERGE_BATCH_SIZE = 200;
/**
 * Keep auth callbacks bounded independently of ordinary review writes. The
 * sign-in event gets one five-second attempt; if Neon is cold or a lock is
 * busy, the trusted guest cookie remains and the authenticated app retries
 * through `/api/auth/claim-guest-progress`.
 */
export const GUEST_CLAIM_MAX_ATTEMPTS = 1;

/**
 * The no-conflict path is bulk/constant-query. A larger history that cannot
 * complete inside this budget is retried after sign-in instead of making the
 * authentication redirect appear hung.
 */
export const GUEST_CLAIM_TRANSACTION = {
  ...SERIALIZABLE_REVIEW_TRANSACTION,
  maxWait: GUEST_CLAIM_MAX_WAIT_MS,
  timeout: GUEST_CLAIM_TIMEOUT_MS,
} as const;

function safeIntAdd(left: number, right: number): number {
  return Math.min(MAX_POSTGRES_INT, Math.max(0, left) + Math.max(0, right));
}

function dateMs(value: Date | null | undefined): number {
  return value?.getTime() ?? Number.NEGATIVE_INFINITY;
}

function laterDate(
  left: Date | null | undefined,
  right: Date | null | undefined,
): Date | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function weightedAverage(
  left: number | null,
  leftWeight: number,
  right: number | null,
  rightWeight: number,
): number | null {
  if (left == null) return right;
  if (right == null) return left;
  const totalWeight = Math.max(0, leftWeight) + Math.max(0, rightWeight);
  if (totalWeight === 0) return Math.round((left + right) / 2);
  return Math.round(
    ((left * Math.max(0, leftWeight)) + (right * Math.max(0, rightWeight)))
      / totalWeight,
  );
}

function nullableJson(value: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof PrismaRuntime.DbNull {
  return value === null ? PrismaRuntime.DbNull : value as Prisma.InputJsonValue;
}

function serializeBulkValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (
    value === PrismaRuntime.DbNull
    || value === PrismaRuntime.JsonNull
    || value === PrismaRuntime.AnyNull
  ) {
    return null;
  }
  return value;
}

function bulkPayload(
  rows: Array<{ id: string; data: Record<string, unknown> }>,
): string {
  return JSON.stringify(
    rows.map(({ id, data }) => ({
      id,
      ...Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          serializeBulkValue(value),
        ]),
      ),
    })),
  );
}

async function runBulkBatches(
  rows: Array<{ id: string; data: Record<string, unknown> }>,
  execute: (payload: string) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += BULK_MERGE_BATCH_SIZE) {
    await execute(bulkPayload(rows.slice(start, start + BULK_MERGE_BATCH_SIZE)));
  }
}

async function bulkUpdateCardProgress(
  tx: Prisma.TransactionClient,
  rows: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<void> {
  await runBulkBatches(rows, (payload) => tx.$executeRaw(
    PrismaRuntime.sql`
      UPDATE "CardProgress" AS "target"
      SET
        "stabilityDays" = "merged"."stabilityDays",
        "nextDueAt" = "merged"."nextDueAt",
        "lastReview" = "merged"."lastReview",
        "lastQuality" = "merged"."lastQuality",
        "totalReviews" = "merged"."totalReviews",
        "correctCount" = "merged"."correctCount",
        "liked" = "merged"."liked",
        "suppressed" = "merged"."suppressed",
        "flagged" = "merged"."flagged",
        "flaggedAt" = "merged"."flaggedAt",
        "flagReason" = "merged"."flagReason",
        "flagContext" = "merged"."flagContext",
        "feedbackAt" = "merged"."feedbackAt",
        "status" = "merged"."status",
        "avgResponseTimeMs" = "merged"."avgResponseTimeMs",
        "consecutiveCorrectFast" = "merged"."consecutiveCorrectFast",
        "masteredAt" = "merged"."masteredAt",
        "retrievalStrength" = "merged"."retrievalStrength",
        "confusedWith" = "merged"."confusedWith",
        "reviewContext" = "merged"."reviewContext",
        "recentFailCount" = "merged"."recentFailCount",
        "recentFailWindowStart" = "merged"."recentFailWindowStart",
        "lastFailedAt" = "merged"."lastFailedAt",
        "leechSuppressedUntil" = "merged"."leechSuppressedUntil",
        "leechSuppressionCount" = "merged"."leechSuppressionCount",
        "leechReplacementCardId" = "merged"."leechReplacementCardId",
        "viewsToday" = "merged"."viewsToday",
        "viewsTodayDate" = "merged"."viewsTodayDate"
      FROM jsonb_to_recordset(${payload}::jsonb) AS "merged"(
        "id" text,
        "stabilityDays" double precision,
        "nextDueAt" timestamptz,
        "lastReview" timestamptz,
        "lastQuality" integer,
        "totalReviews" integer,
        "correctCount" integer,
        "liked" boolean,
        "suppressed" boolean,
        "flagged" boolean,
        "flaggedAt" timestamptz,
        "flagReason" text,
        "flagContext" jsonb,
        "feedbackAt" timestamptz,
        "status" text,
        "avgResponseTimeMs" integer,
        "consecutiveCorrectFast" integer,
        "masteredAt" timestamptz,
        "retrievalStrength" double precision,
        "confusedWith" text[],
        "reviewContext" jsonb,
        "recentFailCount" integer,
        "recentFailWindowStart" timestamptz,
        "lastFailedAt" timestamptz,
        "leechSuppressedUntil" timestamptz,
        "leechSuppressionCount" integer,
        "leechReplacementCardId" text,
        "viewsToday" integer,
        "viewsTodayDate" timestamptz
      )
      WHERE "target"."id" = "merged"."id"
    `,
  ));
}

async function bulkUpdateDailyStats(
  tx: Prisma.TransactionClient,
  rows: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<void> {
  await runBulkBatches(rows, (payload) => tx.$executeRaw(
    PrismaRuntime.sql`
      UPDATE "DailyStats" AS "target"
      SET
        "cardsReviewed" = "merged"."cardsReviewed",
        "cardsCorrect" = "merged"."cardsCorrect",
        "newCardsSeen" = "merged"."newCardsSeen",
        "studyTimeMin" = "merged"."studyTimeMin",
        "studyTimeMs" = "merged"."studyTimeMs",
        "pagesViewed" = "merged"."pagesViewed",
        "quizzesTaken" = "merged"."quizzesTaken"
      FROM jsonb_to_recordset(${payload}::jsonb) AS "merged"(
        "id" text,
        "cardsReviewed" integer,
        "cardsCorrect" integer,
        "newCardsSeen" integer,
        "studyTimeMin" integer,
        "studyTimeMs" integer,
        "pagesViewed" integer,
        "quizzesTaken" integer
      )
      WHERE "target"."id" = "merged"."id"
    `,
  ));
}

async function bulkUpdateConceptStates(
  tx: Prisma.TransactionClient,
  rows: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<void> {
  await runBulkBatches(rows, (payload) => tx.$executeRaw(
    PrismaRuntime.sql`
      UPDATE "ConceptState" AS "target"
      SET
        "recallProbability" = "merged"."recallProbability",
        "recallOnExamDay" = "merged"."recallOnExamDay",
        "confidence" = "merged"."confidence",
        "decayRate" = "merged"."decayRate",
        "lastProbeAt" = "merged"."lastProbeAt",
        "lastExposureAt" = "merged"."lastExposureAt",
        "avgResponseMs" = "merged"."avgResponseMs",
        "responseVariance" = "merged"."responseVariance",
        "recentFailRate" = "merged"."recentFailRate",
        "inStruggleRegion" = "merged"."inStruggleRegion",
        "exposureCount" = "merged"."exposureCount",
        "probeCount" = "merged"."probeCount",
        "localKnowledgeVector" = "merged"."localKnowledgeVector",
        "localKnowledgeUpdatedAt" = "merged"."localKnowledgeUpdatedAt",
        "lastComputed" = "merged"."lastComputed"
      FROM jsonb_to_recordset(${payload}::jsonb) AS "merged"(
        "id" text,
        "recallProbability" double precision,
        "recallOnExamDay" double precision,
        "confidence" double precision,
        "decayRate" double precision,
        "lastProbeAt" timestamptz,
        "lastExposureAt" timestamptz,
        "avgResponseMs" double precision,
        "responseVariance" double precision,
        "recentFailRate" double precision,
        "inStruggleRegion" boolean,
        "exposureCount" integer,
        "probeCount" integer,
        "localKnowledgeVector" double precision[],
        "localKnowledgeUpdatedAt" timestamptz,
        "lastComputed" timestamptz
      )
      WHERE "target"."id" = "merged"."id"
    `,
  ));
}

async function bulkUpdateClusterStates(
  tx: Prisma.TransactionClient,
  rows: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<void> {
  await runBulkBatches(rows, (payload) => tx.$executeRaw(
    PrismaRuntime.sql`
      UPDATE "UserClusterState" AS "target"
      SET
        "mastery" = "merged"."mastery",
        "avgRetrieval" = "merged"."avgRetrieval",
        "coverage" = "merged"."coverage",
        "cardsReviewed" = "merged"."cardsReviewed",
        "cardsTotal" = "merged"."cardsTotal",
        "needsAttention" = "merged"."needsAttention",
        "lastReviewedAt" = "merged"."lastReviewedAt",
        "lastComputedAt" = "merged"."lastComputedAt"
      FROM jsonb_to_recordset(${payload}::jsonb) AS "merged"(
        "id" text,
        "mastery" double precision,
        "avgRetrieval" double precision,
        "coverage" double precision,
        "cardsReviewed" integer,
        "cardsTotal" integer,
        "needsAttention" boolean,
        "lastReviewedAt" timestamptz,
        "lastComputedAt" timestamptz
      )
      WHERE "target"."id" = "merged"."id"
    `,
  ));
}

async function bulkUpdateVideoProgress(
  tx: Prisma.TransactionClient,
  rows: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<void> {
  await runBulkBatches(rows, (payload) => tx.$executeRaw(
    PrismaRuntime.sql`
      UPDATE "VideoProgress" AS "target"
      SET
        "watched" = "merged"."watched",
        "watchedAt" = "merged"."watchedAt",
        "liked" = "merged"."liked",
        "bookmarked" = "merged"."bookmarked",
        "watchedSecs" = "merged"."watchedSecs"
      FROM jsonb_to_recordset(${payload}::jsonb) AS "merged"(
        "id" text,
        "watched" boolean,
        "watchedAt" timestamptz,
        "liked" boolean,
        "bookmarked" boolean,
        "watchedSecs" integer
      )
      WHERE "target"."id" = "merged"."id"
    `,
  ));
}

/**
 * Merge two rows for the same card without moving an authenticated learner
 * backwards. Counters combine because they represent disjoint pre/post-login
 * work, but every field that describes the scheduler's current state comes
 * from one coherent row: the row with the latest review.
 *
 * Combining an old "mastered" status / long due date with a newer failed
 * outcome creates a state that never existed and can postpone the very card
 * the learner just failed. Preferences and additive counters are the only
 * fields merged independently.
 */
export function mergeCardProgressRows(
  account: CardProgress,
  guest: CardProgress,
): Prisma.CardProgressUncheckedUpdateInput {
  const guestIsNewer = dateMs(guest.lastReview) > dateMs(account.lastReview);
  const latest = guestIsNewer ? guest : account;
  const latestFlag = dateMs(guest.flaggedAt) > dateMs(account.flaggedAt)
    ? guest
    : account;
  const sameViewsDay = account.viewsTodayDate?.getTime()
    === guest.viewsTodayDate?.getTime();
  const latestViews = dateMs(guest.viewsTodayDate) > dateMs(account.viewsTodayDate)
    ? guest
    : account;
  const totalReviews = safeIntAdd(account.totalReviews, guest.totalReviews);
  // Retired is an authenticated-account serving preference, not mastery.
  // A guest row may not retire an account card, while an account retirement
  // survives a later guest review.
  const latestStatus = account.status === 'retired'
    ? 'retired'
    : latest.status === 'retired'
      ? account.status
      : latest.status;

  return {
    stabilityDays: latest.stabilityDays,
    nextDueAt: latest.nextDueAt,
    lastReview: latest.lastReview,
    lastQuality: latest.lastQuality,
    totalReviews,
    correctCount: Math.min(
      totalReviews,
      safeIntAdd(account.correctCount, guest.correctCount),
    ),
    liked: account.liked || guest.liked,
    suppressed: account.suppressed || guest.suppressed,
    flagged: account.flagged || guest.flagged,
    flaggedAt: laterDate(account.flaggedAt, guest.flaggedAt),
    flagReason: latestFlag.flagReason ?? account.flagReason ?? guest.flagReason,
    flagContext: nullableJson(
      latestFlag.flagContext ?? account.flagContext ?? guest.flagContext,
    ),
    feedbackAt: laterDate(account.feedbackAt, guest.feedbackAt),
    status: latestStatus,
    avgResponseTimeMs: weightedAverage(
      account.avgResponseTimeMs,
      account.totalReviews,
      guest.avgResponseTimeMs,
      guest.totalReviews,
    ),
    consecutiveCorrectFast: latest.consecutiveCorrectFast,
    masteredAt: latestStatus === 'mastered' ? latest.masteredAt : null,
    retrievalStrength: latest.retrievalStrength,
    confusedWith: [...new Set([...account.confusedWith, ...guest.confusedWith])],
    reviewContext: nullableJson(latest.reviewContext),
    recentFailCount: latest.recentFailCount,
    recentFailWindowStart: latest.recentFailWindowStart,
    lastFailedAt: laterDate(account.lastFailedAt, guest.lastFailedAt),
    leechSuppressedUntil: laterDate(
      account.leechSuppressedUntil,
      guest.leechSuppressedUntil,
    ),
    leechSuppressionCount: safeIntAdd(
      account.leechSuppressionCount,
      guest.leechSuppressionCount,
    ),
    leechReplacementCardId:
      account.leechReplacementCardId ?? guest.leechReplacementCardId,
    viewsToday: sameViewsDay
      ? safeIntAdd(account.viewsToday, guest.viewsToday)
      : latestViews.viewsToday,
    viewsTodayDate: laterDate(account.viewsTodayDate, guest.viewsTodayDate),
  };
}

function mergeDailyStatsRows(
  account: DailyStats,
  guest: DailyStats,
): Prisma.DailyStatsUncheckedUpdateInput {
  const studyTimeMs = safeIntAdd(account.studyTimeMs, guest.studyTimeMs);
  return {
    cardsReviewed: safeIntAdd(account.cardsReviewed, guest.cardsReviewed),
    cardsCorrect: safeIntAdd(account.cardsCorrect, guest.cardsCorrect),
    newCardsSeen: safeIntAdd(account.newCardsSeen, guest.newCardsSeen),
    studyTimeMs,
    studyTimeMin: Math.max(
      safeIntAdd(account.studyTimeMin, guest.studyTimeMin),
      Math.floor(studyTimeMs / 60_000),
    ),
    pagesViewed: safeIntAdd(account.pagesViewed, guest.pagesViewed),
    quizzesTaken: safeIntAdd(account.quizzesTaken, guest.quizzesTaken),
  };
}

function mergeConceptStateRows(
  account: ConceptState,
  guest: ConceptState,
): Prisma.ConceptStateUncheckedUpdateInput {
  return {
    recallProbability: Math.max(
      account.recallProbability,
      guest.recallProbability,
    ),
    recallOnExamDay: Math.max(account.recallOnExamDay, guest.recallOnExamDay),
    confidence: Math.max(account.confidence, guest.confidence),
    // Decay is a learned user parameter. Never overwrite an account estimate
    // with a guest estimate simply because the guest row is newer.
    decayRate: account.decayRate,
    lastProbeAt: laterDate(account.lastProbeAt, guest.lastProbeAt),
    lastExposureAt: laterDate(account.lastExposureAt, guest.lastExposureAt),
    avgResponseMs: weightedAverage(
      account.avgResponseMs,
      account.probeCount,
      guest.avgResponseMs,
      guest.probeCount,
    ),
    responseVariance:
      account.responseVariance ?? guest.responseVariance,
    recentFailRate: Math.max(account.recentFailRate, guest.recentFailRate),
    inStruggleRegion: account.inStruggleRegion || guest.inStruggleRegion,
    exposureCount: safeIntAdd(account.exposureCount, guest.exposureCount),
    probeCount: safeIntAdd(account.probeCount, guest.probeCount),
    localKnowledgeVector: account.localKnowledgeVector.length > 0
      ? account.localKnowledgeVector
      : guest.localKnowledgeVector,
    localKnowledgeUpdatedAt: laterDate(
      account.localKnowledgeUpdatedAt,
      guest.localKnowledgeUpdatedAt,
    ),
    lastComputed: laterDate(account.lastComputed, guest.lastComputed)
      ?? account.lastComputed,
  };
}

function mergeClusterStateRows(
  account: UserClusterState,
  guest: UserClusterState,
): Prisma.UserClusterStateUncheckedUpdateInput {
  return {
    mastery: Math.max(account.mastery, guest.mastery),
    avgRetrieval: Math.max(account.avgRetrieval, guest.avgRetrieval),
    coverage: Math.max(account.coverage, guest.coverage),
    cardsReviewed: Math.max(account.cardsReviewed, guest.cardsReviewed),
    cardsTotal: Math.max(account.cardsTotal, guest.cardsTotal),
    needsAttention: account.needsAttention || guest.needsAttention,
    lastReviewedAt: laterDate(account.lastReviewedAt, guest.lastReviewedAt),
    lastComputedAt: laterDate(account.lastComputedAt, guest.lastComputedAt)
      ?? account.lastComputedAt,
  };
}

function mergeVideoProgressRows(
  account: VideoProgress,
  guest: VideoProgress,
): Prisma.VideoProgressUncheckedUpdateInput {
  return {
    watched: account.watched || guest.watched,
    watchedAt: laterDate(account.watchedAt, guest.watchedAt),
    liked: account.liked || guest.liked,
    bookmarked: account.bookmarked || guest.bookmarked,
    watchedSecs: Math.max(account.watchedSecs, guest.watchedSecs),
  };
}

function emptyCounts(): GuestClaimCounts {
  return {
    cardProgress: 0,
    questionResponses: 0,
    learningEvents: 0,
    dailyStats: 0,
    studyQueues: 0,
    syncOperations: 0,
    conceptStates: 0,
    clusterStates: 0,
    struggleRegions: 0,
    videoProgress: 0,
    reviewSessions: 0,
    assessmentAttempts: 0,
    contentExposures: 0,
    serveDecisions: 0,
    struggleInterventions: 0,
    teachingSignals: 0,
    deepDiveChatSessions: 0,
    deepDiveChatMessages: 0,
  };
}

/**
 * Transaction body, exported for focused tests. Production callers must use
 * claimGuestProgressAfterSignIn(), whose guest identity comes only from the
 * trusted HttpOnly cookie.
 */
export async function claimGuestProgressRecords(
  tx: Prisma.TransactionClient,
  guestUserId: string,
  authenticatedUserId: string,
): Promise<GuestProgressClaimResult> {
  if (guestUserId === authenticatedUserId) {
    return { status: 'not-eligible', reason: 'same-user' };
  }

  // Lock both identities in deterministic order. Review writes take a foreign
  // key lock on User; this prevents a grade from landing under the guest
  // identity halfway through the transfer.
  const lockedIds = [guestUserId, authenticatedUserId].sort();
  await tx.$queryRaw(
    PrismaRuntime.sql`
      SELECT "id"
      FROM "User"
      WHERE "id" IN (${PrismaRuntime.join(lockedIds)})
      ORDER BY "id"
      FOR UPDATE
    `,
  );

  const guest = await tx.user.findUnique({
    where: { id: guestUserId },
    select: {
      id: true,
      email: true,
      currentStreak: true,
      longestStreak: true,
      lastActiveAt: true,
      accounts: { select: { id: true }, take: 1 },
    },
  });
  const authenticatedUser = await tx.user.findUnique({
    where: { id: authenticatedUserId },
    select: {
      id: true,
      currentStreak: true,
      longestStreak: true,
      lastActiveAt: true,
    },
  });

  if (!authenticatedUser) {
    return { status: 'not-eligible', reason: 'authenticated-user-missing' };
  }
  if (!guest) {
    return { status: 'not-eligible', reason: 'guest-missing' };
  }
  if (guest.email !== null || guest.accounts.length > 0) {
    return { status: 'not-eligible', reason: 'guest-not-anonymous' };
  }

  const counts = emptyCounts();

  const guestProgress = await tx.cardProgress.findMany({
    where: { userId: guestUserId },
  });
  const accountProgress = guestProgress.length > 0
    ? await tx.cardProgress.findMany({
        where: {
          userId: authenticatedUserId,
          cardId: { in: guestProgress.map((row) => row.cardId) },
        },
      })
    : [];
  const accountProgressByCard = new Map(
    accountProgress.map((row) => [row.cardId, row]),
  );
  const conflictingGuestProgressIds: string[] = [];
  const mergedCardProgressRows: Array<{
    id: string;
    data: Record<string, unknown>;
  }> = [];
  for (const row of guestProgress) {
    const accountRow = accountProgressByCard.get(row.cardId);
    if (accountRow) {
      mergedCardProgressRows.push({
        id: accountRow.id,
        data: mergeCardProgressRows(accountRow, row) as Record<string, unknown>,
      });
      conflictingGuestProgressIds.push(row.id);
    }
    counts.cardProgress += 1;
  }
  await bulkUpdateCardProgress(tx, mergedCardProgressRows);
  if (conflictingGuestProgressIds.length > 0) {
    await tx.cardProgress.deleteMany({
      where: { id: { in: conflictingGuestProgressIds } },
    });
  }
  if (guestProgress.length > conflictingGuestProgressIds.length) {
    await tx.cardProgress.updateMany({
      where: {
        userId: guestUserId,
        ...(conflictingGuestProgressIds.length > 0
          ? { id: { notIn: conflictingGuestProgressIds } }
          : {}),
      },
      data: { userId: authenticatedUserId },
    });
  }

  // Rank and renumber every guest MCQ attempt in one database statement. This
  // avoids one network round-trip per response while preserving deterministic
  // order after the account's existing maximum attempt number.
  counts.questionResponses = await tx.$executeRaw(
    PrismaRuntime.sql`
      WITH "guest_ranked" AS (
        SELECT
          "id",
          "questionId",
          ROW_NUMBER() OVER (
            PARTITION BY "questionId"
            ORDER BY "createdAt", "attemptNumber", "id"
          ) AS "guestRank"
        FROM "QuestionResponse"
        WHERE "userId" = ${guestUserId}
      ),
      "account_max" AS (
        SELECT "questionId", MAX("attemptNumber") AS "maxAttempt"
        FROM "QuestionResponse"
        WHERE "userId" = ${authenticatedUserId}
        GROUP BY "questionId"
      )
      UPDATE "QuestionResponse" AS "response"
      SET
        "userId" = ${authenticatedUserId},
        "attemptNumber" = (
          COALESCE("account_max"."maxAttempt", 0)
          + "guest_ranked"."guestRank"
        )::integer
      FROM "guest_ranked"
      LEFT JOIN "account_max"
        ON "account_max"."questionId" = "guest_ranked"."questionId"
      WHERE "response"."id" = "guest_ranked"."id"
    `,
  );

  counts.learningEvents = (
    await tx.learningEvent.updateMany({
      where: { userId: guestUserId },
      data: { userId: authenticatedUserId },
    })
  ).count;

  const guestDailyStats = await tx.dailyStats.findMany({
    where: { userId: guestUserId },
  });
  const accountDailyStats = guestDailyStats.length > 0
    ? await tx.dailyStats.findMany({
        where: {
          userId: authenticatedUserId,
          date: { in: guestDailyStats.map((row) => row.date) },
        },
      })
    : [];
  const accountDailyStatsByDate = new Map(
    accountDailyStats.map((row) => [row.date.getTime(), row]),
  );
  const conflictingGuestDailyStatIds: string[] = [];
  const mergedDailyStatsRows: Array<{
    id: string;
    data: Record<string, unknown>;
  }> = [];
  for (const row of guestDailyStats) {
    const accountRow = accountDailyStatsByDate.get(row.date.getTime());
    if (accountRow) {
      mergedDailyStatsRows.push({
        id: accountRow.id,
        data: mergeDailyStatsRows(accountRow, row) as Record<string, unknown>,
      });
      conflictingGuestDailyStatIds.push(row.id);
    }
    counts.dailyStats += 1;
  }
  await bulkUpdateDailyStats(tx, mergedDailyStatsRows);
  if (conflictingGuestDailyStatIds.length > 0) {
    await tx.dailyStats.deleteMany({
      where: { id: { in: conflictingGuestDailyStatIds } },
    });
  }
  if (guestDailyStats.length > conflictingGuestDailyStatIds.length) {
    await tx.dailyStats.updateMany({
      where: {
        userId: guestUserId,
        ...(conflictingGuestDailyStatIds.length > 0
          ? { id: { notIn: conflictingGuestDailyStatIds } }
          : {}),
      },
      data: { userId: authenticatedUserId },
    });
  }

  // Rebuild the denormalized account fields from the now-merged rows before
  // commit. Doing this inside the same serializable transaction prevents an
  // older post-commit streak calculation from overwriting claimed history.
  const mergedDailyStats = await tx.dailyStats.findMany({
    where: { userId: authenticatedUserId },
    orderBy: { date: 'desc' },
    take: 365,
    select: { date: true, cardsReviewed: true, quizzesTaken: true },
  });
  const streak = calculateStreakFromDailyStats(mergedDailyStats);
  const latestActiveDay = mergedDailyStats.reduce<Date | null>(
    (latest, row) => (
      row.cardsReviewed > 0 || row.quizzesTaken > 0
        ? laterDate(latest, row.date)
        : latest
    ),
    null,
  );
  await tx.user.update({
    where: { id: authenticatedUserId },
    data: {
      currentStreak: streak.current,
      longestStreak: Math.max(
        streak.longest,
        authenticatedUser.longestStreak,
        guest.longestStreak,
      ),
      lastActiveAt: laterDate(
        laterDate(authenticatedUser.lastActiveAt, guest.lastActiveAt),
        latestActiveDay,
      ),
    },
  });

  const guestQueues = await tx.userStudyQueue.findMany({
    where: { userId: guestUserId },
    select: { id: true, rotation: true },
  });
  const accountQueues = guestQueues.length > 0
    ? await tx.userStudyQueue.findMany({
        where: {
          userId: authenticatedUserId,
          rotation: { in: guestQueues.map((row) => row.rotation) },
        },
        select: { id: true, rotation: true },
      })
    : [];
  const accountQueueRotations = new Set(
    accountQueues.map((row) => row.rotation),
  );
  const conflictingGuestQueueIds = guestQueues
    .filter((row) => accountQueueRotations.has(row.rotation))
    .map((row) => row.id);
  if (conflictingGuestQueueIds.length > 0) {
    await tx.userStudyQueue.deleteMany({
      where: { id: { in: conflictingGuestQueueIds } },
    });
  }
  if (guestQueues.length > conflictingGuestQueueIds.length) {
    await tx.userStudyQueue.updateMany({
      where: {
        userId: guestUserId,
        ...(conflictingGuestQueueIds.length > 0
          ? { id: { notIn: conflictingGuestQueueIds } }
          : {}),
      },
      data: { userId: authenticatedUserId },
    });
  }
  counts.studyQueues = guestQueues.length;

  // Moving completed receipts is what makes an offline grade replay after
  // sign-in remain exactly-once under the account identity.
  const guestOperations = await tx.syncOperation.findMany({
    where: { userId: guestUserId },
    select: { id: true, clientOperationId: true },
    orderBy: [{ processedAt: 'asc' }, { id: 'asc' }],
  });
  const accountOperations = guestOperations.length > 0
    ? await tx.syncOperation.findMany({
        where: {
          userId: authenticatedUserId,
          clientOperationId: {
            in: guestOperations.map((row) => row.clientOperationId),
          },
        },
        select: { id: true, clientOperationId: true },
      })
    : [];
  const accountOperationIds = new Set(
    accountOperations.map((row) => row.clientOperationId),
  );
  const conflictingGuestOperationIds = guestOperations
    .filter((row) => accountOperationIds.has(row.clientOperationId))
    .map((row) => row.id);
  if (conflictingGuestOperationIds.length > 0) {
    await tx.syncOperation.deleteMany({
      where: { id: { in: conflictingGuestOperationIds } },
    });
  }
  if (guestOperations.length > conflictingGuestOperationIds.length) {
    await tx.syncOperation.updateMany({
      where: {
        userId: guestUserId,
        ...(conflictingGuestOperationIds.length > 0
          ? { id: { notIn: conflictingGuestOperationIds } }
          : {}),
      },
      data: { userId: authenticatedUserId },
    });
  }
  counts.syncOperations = guestOperations.length;

  const guestConceptStates = await tx.conceptState.findMany({
    where: { userId: guestUserId },
  });
  const accountConceptStates = guestConceptStates.length > 0
    ? await tx.conceptState.findMany({
        where: {
          userId: authenticatedUserId,
          conceptId: { in: guestConceptStates.map((row) => row.conceptId) },
        },
      })
    : [];
  const accountConceptStateByConcept = new Map(
    accountConceptStates.map((row) => [row.conceptId, row]),
  );
  const conflictingGuestConceptStateIds: string[] = [];
  const mergedConceptStateRows: Array<{
    id: string;
    data: Record<string, unknown>;
  }> = [];
  for (const row of guestConceptStates) {
    const accountRow = accountConceptStateByConcept.get(row.conceptId);
    if (accountRow) {
      mergedConceptStateRows.push({
        id: accountRow.id,
        data: mergeConceptStateRows(accountRow, row) as Record<string, unknown>,
      });
      conflictingGuestConceptStateIds.push(row.id);
    }
    counts.conceptStates += 1;
  }
  await bulkUpdateConceptStates(tx, mergedConceptStateRows);
  if (conflictingGuestConceptStateIds.length > 0) {
    await tx.conceptState.deleteMany({
      where: { id: { in: conflictingGuestConceptStateIds } },
    });
  }
  if (guestConceptStates.length > conflictingGuestConceptStateIds.length) {
    await tx.conceptState.updateMany({
      where: {
        userId: guestUserId,
        ...(conflictingGuestConceptStateIds.length > 0
          ? { id: { notIn: conflictingGuestConceptStateIds } }
          : {}),
      },
      data: { userId: authenticatedUserId },
    });
  }

  const guestClusterStates = await tx.userClusterState.findMany({
    where: { userId: guestUserId },
  });
  const accountClusterStates = guestClusterStates.length > 0
    ? await tx.userClusterState.findMany({
        where: {
          userId: authenticatedUserId,
          clusterId: { in: guestClusterStates.map((row) => row.clusterId) },
        },
      })
    : [];
  const accountClusterStateByCluster = new Map(
    accountClusterStates.map((row) => [row.clusterId, row]),
  );
  const conflictingGuestClusterStateIds: string[] = [];
  const mergedClusterStateRows: Array<{
    id: string;
    data: Record<string, unknown>;
  }> = [];
  for (const row of guestClusterStates) {
    const accountRow = accountClusterStateByCluster.get(row.clusterId);
    if (accountRow) {
      mergedClusterStateRows.push({
        id: accountRow.id,
        data: mergeClusterStateRows(accountRow, row) as Record<string, unknown>,
      });
      conflictingGuestClusterStateIds.push(row.id);
    }
    counts.clusterStates += 1;
  }
  await bulkUpdateClusterStates(tx, mergedClusterStateRows);
  if (conflictingGuestClusterStateIds.length > 0) {
    await tx.userClusterState.deleteMany({
      where: { id: { in: conflictingGuestClusterStateIds } },
    });
  }
  if (guestClusterStates.length > conflictingGuestClusterStateIds.length) {
    await tx.userClusterState.updateMany({
      where: {
        userId: guestUserId,
        ...(conflictingGuestClusterStateIds.length > 0
          ? { id: { notIn: conflictingGuestClusterStateIds } }
          : {}),
      },
      data: { userId: authenticatedUserId },
    });
  }

  // Active struggle state is a materialized preference/state row. If the
  // account already has one for a rotation, keep it intact.
  const guestStruggleRegions = await tx.userStruggleRegion.findMany({
    where: { userId: guestUserId },
    select: { id: true, rotation: true },
  });
  const accountStruggleRegions = guestStruggleRegions.length > 0
    ? await tx.userStruggleRegion.findMany({
        where: {
          userId: authenticatedUserId,
          rotation: { in: guestStruggleRegions.map((row) => row.rotation) },
        },
        select: { id: true, rotation: true },
      })
    : [];
  const accountStruggleRotations = new Set(
    accountStruggleRegions.map((row) => row.rotation),
  );
  const conflictingGuestStruggleRegionIds = guestStruggleRegions
    .filter((row) => accountStruggleRotations.has(row.rotation))
    .map((row) => row.id);
  if (conflictingGuestStruggleRegionIds.length > 0) {
    await tx.userStruggleRegion.deleteMany({
      where: { id: { in: conflictingGuestStruggleRegionIds } },
    });
  }
  if (
    guestStruggleRegions.length
    > conflictingGuestStruggleRegionIds.length
  ) {
    await tx.userStruggleRegion.updateMany({
      where: {
        userId: guestUserId,
        ...(conflictingGuestStruggleRegionIds.length > 0
          ? { id: { notIn: conflictingGuestStruggleRegionIds } }
          : {}),
      },
      data: { userId: authenticatedUserId },
    });
  }
  counts.struggleRegions = guestStruggleRegions.length;

  const guestVideoProgress = await tx.videoProgress.findMany({
    where: { userId: guestUserId },
  });
  const accountVideoProgress = guestVideoProgress.length > 0
    ? await tx.videoProgress.findMany({
        where: {
          userId: authenticatedUserId,
          videoId: { in: guestVideoProgress.map((row) => row.videoId) },
        },
      })
    : [];
  const accountVideoProgressByVideo = new Map(
    accountVideoProgress.map((row) => [row.videoId, row]),
  );
  const conflictingGuestVideoProgressIds: string[] = [];
  const mergedVideoProgressRows: Array<{
    id: string;
    data: Record<string, unknown>;
  }> = [];
  for (const row of guestVideoProgress) {
    const accountRow = accountVideoProgressByVideo.get(row.videoId);
    if (accountRow) {
      mergedVideoProgressRows.push({
        id: accountRow.id,
        data: mergeVideoProgressRows(accountRow, row) as Record<string, unknown>,
      });
      conflictingGuestVideoProgressIds.push(row.id);
    }
    counts.videoProgress += 1;
  }
  await bulkUpdateVideoProgress(tx, mergedVideoProgressRows);
  if (conflictingGuestVideoProgressIds.length > 0) {
    await tx.videoProgress.deleteMany({
      where: { id: { in: conflictingGuestVideoProgressIds } },
    });
  }
  if (guestVideoProgress.length > conflictingGuestVideoProgressIds.length) {
    await tx.videoProgress.updateMany({
      where: {
        userId: guestUserId,
        ...(conflictingGuestVideoProgressIds.length > 0
          ? { id: { notIn: conflictingGuestVideoProgressIds } }
          : {}),
      },
      data: { userId: authenticatedUserId },
    });
  }

  counts.reviewSessions = (
    await tx.reviewSession.updateMany({
      where: { userId: guestUserId },
      data: { userId: authenticatedUserId },
    })
  ).count;
  counts.assessmentAttempts = (
    await tx.assessmentAttempt.updateMany({
      where: { userId: guestUserId },
      data: { userId: authenticatedUserId },
    })
  ).count;
  counts.contentExposures = (
    await tx.contentExposure.updateMany({
      where: { userId: guestUserId },
      data: { userId: authenticatedUserId },
    })
  ).count;
  counts.serveDecisions = (
    await tx.serveDecision.updateMany({
      where: { userId: guestUserId },
      data: { userId: authenticatedUserId },
    })
  ).count;
  counts.struggleInterventions = (
    await tx.struggleIntervention.updateMany({
      where: { userId: guestUserId },
      data: { userId: authenticatedUserId },
    })
  ).count;
  counts.teachingSignals = (
    await tx.teachingSignal.updateMany({
      where: { userId: guestUserId },
      data: { userId: authenticatedUserId },
    })
  ).count;

  // A guest can use the deep-dive tutor before signing in. Lock its session
  // rows so a concurrent assistant response either lands before this transfer
  // or waits until the surviving session has its final owner.
  await tx.$queryRaw(
    PrismaRuntime.sql`
      SELECT "id"
      FROM "DeepDiveChatSession"
      WHERE "userId" = ${guestUserId}
      ORDER BY "id"
      FOR UPDATE
    `,
  );
  const guestChatSessions = await tx.deepDiveChatSession.findMany({
    where: { userId: guestUserId },
    select: { id: true },
  });
  const guestChatSessionIds = guestChatSessions.map((session) => session.id);
  counts.deepDiveChatSessions = guestChatSessions.length;
  counts.deepDiveChatMessages = guestChatSessionIds.length > 0
    ? await tx.deepDiveChatMessage.count({
        where: { sessionId: { in: guestChatSessionIds } },
      })
    : 0;

  if (guestChatSessionIds.length > 0) {
    // If both identities chatted on the same deep dive, append the guest
    // messages to the account's existing session before deleting the duplicate
    // session. Otherwise the guest session id is preserved and only re-owned.
    await tx.$executeRaw(
      PrismaRuntime.sql`
        UPDATE "DeepDiveChatMessage" AS "message"
        SET "sessionId" = "account"."id"
        FROM "DeepDiveChatSession" AS "guest"
        JOIN "DeepDiveChatSession" AS "account"
          ON "account"."deepDiveSlug" = "guest"."deepDiveSlug"
          AND "account"."userId" = ${authenticatedUserId}
        WHERE "guest"."userId" = ${guestUserId}
          AND "message"."sessionId" = "guest"."id"
      `,
    );
    await tx.$executeRaw(
      PrismaRuntime.sql`
        DELETE FROM "DeepDiveChatSession" AS "guest"
        USING "DeepDiveChatSession" AS "account"
        WHERE "guest"."userId" = ${guestUserId}
          AND "account"."userId" = ${authenticatedUserId}
          AND "account"."deepDiveSlug" = "guest"."deepDiveSlug"
      `,
    );
    await tx.deepDiveChatSession.updateMany({
      where: { userId: guestUserId },
      data: { userId: authenticatedUserId },
    });
  }

  const movedCount = Object.values(counts).reduce(
    (sum, count) => sum + count,
    0,
  );

  // The terminal delete is the durable concurrency boundary. A grade that
  // already acquired a foreign-key lock commits before this transaction and
  // is included above. A request carrying the old cookie that reaches its
  // first canonical write after commit now fails its User FK and is safely
  // retried by the client under the authenticated identity; it cannot recreate
  // progress under an orphan guest.
  await tx.user.delete({
    where: { id: guestUserId },
    select: { id: true },
  });

  return movedCount === 0
    ? { status: 'nothing-to-claim', counts }
    : { status: 'claimed', counts };
}

/**
 * Auth.js entry point. No request/body/query value can select the guest: the
 * random HttpOnly cookie is read internally and eligibility is re-verified
 * under the same serializable transaction that moves the rows.
 */
export async function claimGuestProgressAfterSignIn(
  authenticatedUserId: string,
): Promise<GuestProgressClaimResult> {
  let guestUserId: string | null;
  try {
    guestUserId = await readGuestUserCookie();
  } catch (error) {
    logger.warn('guest-progress-claim-failed', {
      authenticatedUserId,
      error: String(error),
    });
    return { status: 'failed' };
  }
  if (!guestUserId) {
    return { status: 'not-eligible', reason: 'cookie-missing' };
  }

  let result: GuestProgressClaimResult | null = null;
  try {
    for (
      let attempt = 1;
      attempt <= GUEST_CLAIM_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        result = await prisma.$transaction(
          (tx) => claimGuestProgressRecords(
            tx as unknown as Prisma.TransactionClient,
            guestUserId,
            authenticatedUserId,
          ),
          GUEST_CLAIM_TRANSACTION,
        );
        break;
      } catch (error) {
        if (
          attempt < GUEST_CLAIM_MAX_ATTEMPTS
          && isRetryableReviewTransactionError(error)
        ) {
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    logger.warn('guest-progress-claim-failed', {
      authenticatedUserId,
      error: String(error),
    });
    return { status: 'failed' };
  }

  if (!result) {
    logger.warn('guest-progress-claim-failed', {
      authenticatedUserId,
      error: 'transaction returned no result',
    });
    return { status: 'failed' };
  }

  if (result.status === 'claimed' || result.status === 'nothing-to-claim') {
    try {
      await clearGuestUserCookie();
    } catch (error) {
      // The transaction has already committed and terminally deleted the guest
      // identity. A stale cookie cannot authorize new guest writes.
      logger.warn('guest-progress-cookie-clear-failed', {
        authenticatedUserId,
        error: String(error),
      });
    }
  }

  return result;
}
