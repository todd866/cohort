/**
 * Anatomy review tracking backed by core CardProgress/QuestionResponse/LearningEvent.
 */

import { prisma } from '@/lib/prisma';
import {
  updateRetrievalStrength,
  updateStabilityDays,
  computeNextDueAt,
} from '@/lib/manifold';

const MASTERY_THRESHOLD = 0.8;
const CONSECUTIVE_CORRECT_FOR_MASTERY = 3;

export interface TrackingEvent {
  cardId: string;
  cardType: 'spot' | 'flashcard' | 'mcq';
  source: 'usyd-md1' | 'general';
  quality: number; // 0-5
  responseTimeMs: number;
  revealTimeMs?: number;
  sessionId: string;
  positionInSession: number;
  sessionDurationMs: number;
  recentAccuracy: number;
  selectedOption?: string;
  wasCorrect?: boolean;
  occlusionRegionId?: string;
  deviceType?: 'mobile' | 'tablet' | 'desktop';
  daysUntilExam?: number;
}

function isCorrectFromQuality(quality: number): boolean {
  return quality >= 3;
}

function normalizeQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 0;
  return Math.max(0, Math.min(5, Math.round(quality)));
}

export async function resolveAnatomyCardId(candidateId: string): Promise<string | null> {
  const direct = await prisma.card.findFirst({
    where: {
      id: candidateId,
      rotation: 'anatomy',
    },
    select: { id: true },
  });

  if (direct) return direct.id;

  const legacyStable = await prisma.card.findFirst({
    where: {
      rotation: 'anatomy',
      stableId: `anatomy-flashcard-${candidateId}`,
    },
    select: { id: true },
  });

  if (legacyStable) return legacyStable.id;

  const fromStructure = await prisma.card.findFirst({
    where: {
      rotation: 'anatomy',
      annotations: {
        path: ['structureId'],
        equals: candidateId,
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  return fromStructure?.id ?? null;
}

/**
 * Update core progress tables. Critical path, runs synchronously.
 */
export async function updateAnatomyProgress(
  userId: string,
  event: TrackingEvent
): Promise<void> {
  const now = new Date();
  const quality = normalizeQuality(event.quality);

  if (event.cardType === 'mcq') {
    const question = await prisma.question.findFirst({
      where: {
        id: event.cardId,
        rotation: 'anatomy',
      },
      select: { id: true },
    });

    if (!question) return;

    const existingAttempts = await prisma.questionResponse.count({
      where: {
        userId,
        questionId: question.id,
      },
    });

    await prisma.questionResponse.create({
      data: {
        userId,
        questionId: question.id,
        selectedOption: event.selectedOption ?? 'unknown',
        isCorrect: event.wasCorrect ?? isCorrectFromQuality(quality),
        responseTimeMs: event.responseTimeMs,
        sessionType: 'review',
        attemptNumber: existingAttempts + 1,
      },
    });

    return;
  }

  const resolvedCardId = await resolveAnatomyCardId(event.cardId);
  if (!resolvedCardId) return;

  const existing = await prisma.cardProgress.findUnique({
    where: {
      cardId_userId: {
        cardId: resolvedCardId,
        userId,
      },
    },
  });

  const daysSinceLastReview = existing?.lastReview
    ? (now.getTime() - existing.lastReview.getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  const currentStability = existing?.stabilityDays ?? 1;
  const currentStrength = existing?.retrievalStrength ?? 0;

  const newStability = updateStabilityDays(currentStability, quality, 'anatomy', now);
  const newStrength = updateRetrievalStrength(
    currentStrength,
    quality,
    existing?.totalReviews ?? 0,
    daysSinceLastReview,
    currentStability
  );

  const nextDueAt = computeNextDueAt(
    newStrength,
    now,
    newStability,
    0.7,
    now
  );

  const isCorrect = isCorrectFromQuality(quality);
  const newConsecutiveCorrect = isCorrect
    ? (existing?.consecutiveCorrectFast ?? 0) + 1
    : 0;

  let status = existing?.status ?? 'learning';
  let masteredAt = existing?.masteredAt ?? null;

  if (
    newStrength >= MASTERY_THRESHOLD &&
    newConsecutiveCorrect >= CONSECUTIVE_CORRECT_FOR_MASTERY
  ) {
    status = 'mastered';
    masteredAt = masteredAt ?? now;
  } else if ((existing?.totalReviews ?? 0) + 1 >= 2) {
    status = 'reviewing';
  } else {
    status = 'learning';
  }

  await prisma.cardProgress.upsert({
    where: {
      cardId_userId: {
        cardId: resolvedCardId,
        userId,
      },
    },
    update: {
      retrievalStrength: newStrength,
      stabilityDays: newStability,
      nextDueAt,
      totalReviews: { increment: 1 },
      correctCount: isCorrect ? { increment: 1 } : undefined,
      lastReview: now,
      lastQuality: quality,
      status,
      consecutiveCorrectFast: newConsecutiveCorrect,
      masteredAt,
    },
    create: {
      cardId: resolvedCardId,
      userId,
      retrievalStrength: newStrength,
      stabilityDays: newStability,
      nextDueAt,
      totalReviews: 1,
      correctCount: isCorrect ? 1 : 0,
      lastReview: now,
      lastQuality: quality,
      status,
      consecutiveCorrectFast: newConsecutiveCorrect,
      masteredAt,
    },
  });
}

/**
 * Async analytics event logging into unified LearningEvent.
 */
export async function logAnatomyEvent(
  userId: string,
  event: TrackingEvent
): Promise<void> {
  const now = new Date();
  const quality = normalizeQuality(event.quality);
  const isCorrect = event.wasCorrect ?? isCorrectFromQuality(quality);

  if (event.cardType === 'mcq') {
    const question = await prisma.question.findFirst({
      where: {
        id: event.cardId,
        rotation: 'anatomy',
      },
      select: {
        id: true,
        topics: true,
        week: true,
      },
    });

    if (!question) return;

    await prisma.learningEvent.create({
      data: {
        userId,
        eventType: 'mcq_attempted',
        sourceType: 'question',
        sourceId: question.id,
        quality,
        isCorrect,
        responseMs: event.responseTimeMs,
        conceptIds: question.topics,
        rotation: 'anatomy',
        week: question.week,
        metadata: {
          source: event.source,
          cardType: event.cardType,
          sessionId: event.sessionId,
          selectedOption: event.selectedOption,
          revealTimeMs: event.revealTimeMs,
          positionInSession: event.positionInSession,
          sessionDurationMs: event.sessionDurationMs,
          recentAccuracy: event.recentAccuracy,
          occlusionRegionId: event.occlusionRegionId,
          deviceType: event.deviceType,
          daysUntilExam: event.daysUntilExam,
        },
      },
    });

    return;
  }

  const resolvedCardId = await resolveAnatomyCardId(event.cardId);
  if (!resolvedCardId) return;

  const card = await prisma.card.findUnique({
    where: { id: resolvedCardId },
    select: {
      id: true,
      topics: true,
      week: true,
      rotation: true,
    },
  });

  if (!card) return;

  await prisma.learningEvent.create({
    data: {
      userId,
      eventType: 'card_reviewed',
      sourceType: 'card',
      sourceId: card.id,
      quality,
      isCorrect,
      responseMs: event.responseTimeMs,
      conceptIds: card.topics,
      rotation: card.rotation,
      week: card.week,
      metadata: {
        source: event.source,
        cardType: event.cardType,
        sessionId: event.sessionId,
        revealTimeMs: event.revealTimeMs,
        positionInSession: event.positionInSession,
        sessionDurationMs: event.sessionDurationMs,
        recentAccuracy: event.recentAccuracy,
        occlusionRegionId: event.occlusionRegionId,
        deviceType: event.deviceType,
        daysUntilExam: event.daysUntilExam,
        loggedAt: now.toISOString(),
      },
    },
  });
}

// getDeviceType moved to ./device.ts (client-safe)
export { getDeviceType } from './device';
