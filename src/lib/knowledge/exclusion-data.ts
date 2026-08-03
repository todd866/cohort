/**
 * Exclusion Data Fetcher
 *
 * Fetches recently-seen cards/questions and topic exposure data
 * to prevent repetition within sessions. Used by the background
 * cache refresh path.
 *
 * Extracted from unified-scheduler.ts for modularity.
 */

import { prisma } from '@/lib/prisma';
import {
  MASTERY_CORRECT_THRESHOLD,
  resolveRetirementPolicy,
  retiredQuestionIds,
} from './question-retirement';

export interface ExclusionData {
  excludedCardIds: Set<string>;
  excludedQuestionIds: Set<string>;
  recentTopicExposures: Map<string, { count: number; mostRecentMs: number }>;
  recentClusterExposures: Map<string, number>; // clusterId -> count of recent exposures
}

export async function fetchExclusionData(
  userId: string,
  cardRepeatCutoff: Date,
  questionRepeatCutoff: Date,
): Promise<ExclusionData> {
  const [recentExposureEvents, recentQuestionResponses, masteredQuestions] = await Promise.all([
    prisma.learningEvent.findMany({
      where: {
        userId,
        sourceType: { in: ['card', 'question'] },
        eventType: { in: ['card_reviewed', 'mcq_attempted', 'content_exposed'] },
        timestamp: { gte: questionRepeatCutoff },
      },
      select: { sourceId: true, sourceType: true, timestamp: true, metadata: true },
    }),
    prisma.questionResponse.findMany({
      where: { userId, createdAt: { gte: questionRepeatCutoff } },
      select: { questionId: true },
      distinct: ['questionId'],
    }),
    prisma.questionResponse.groupBy({
      by: ['questionId'],
      where: {
        userId,
        isCorrect: true,
      },
      _count: { questionId: true },
      having: {
        questionId: { _count: { gte: MASTERY_CORRECT_THRESHOLD } },
      },
    }),
  ]);

  const excludedCardIds = new Set<string>();
  const excludedQuestionIds = new Set<string>();

  for (const event of recentExposureEvents) {
    if (event.sourceType === 'card' && event.timestamp >= cardRepeatCutoff) {
      excludedCardIds.add(event.sourceId);
    }
    if (event.sourceType === 'question' && event.timestamp >= questionRepeatCutoff) {
      excludedQuestionIds.add(event.sourceId);
    }
  }

  for (const response of recentQuestionResponses) {
    excludedQuestionIds.add(response.questionId);
  }

  // Mastery no longer excludes. It SINKS a question in ranking instead
  // (question-retirement.ts / partitionByFreshness) — permanent retirement let a
  // pattern-matched 2nd correct delete a question the user never learned. Empty
  // unless MD3_PERMANENT_QUESTION_RETIREMENT=1 restores the legacy rule.
  for (const questionId of retiredQuestionIds(
    masteredQuestions.map((mq) => mq.questionId),
    resolveRetirementPolicy()
  )) {
    excludedQuestionIds.add(questionId);
  }

  // Build topic exposure map for cross-session topic cooldown
  // and cluster exposure map for inter-session cluster dampening
  const recentTopicExposures = new Map<string, { count: number; mostRecentMs: number }>();
  const recentClusterExposures = new Map<string, number>();
  for (const event of recentExposureEvents) {
    if (event.sourceType !== 'card' || event.timestamp < cardRepeatCutoff) continue;
    const meta = event.metadata as Record<string, unknown> | null;
    const topics = meta?.topics;
    if (!Array.isArray(topics)) continue;
    const tsMs = event.timestamp.getTime();
    for (const topic of topics) {
      if (typeof topic !== 'string') continue;
      const existing = recentTopicExposures.get(topic);
      if (existing) {
        existing.count += 1;
        if (tsMs > existing.mostRecentMs) existing.mostRecentMs = tsMs;
      } else {
        recentTopicExposures.set(topic, { count: 1, mostRecentMs: tsMs });
      }
    }
    // Track cluster exposure counts
    const clusterId = meta?.clusterId;
    if (typeof clusterId === 'string') {
      recentClusterExposures.set(clusterId, (recentClusterExposures.get(clusterId) ?? 0) + 1);
    }
  }

  return { excludedCardIds, excludedQuestionIds, recentTopicExposures, recentClusterExposures };
}
