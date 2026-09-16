import {
  applyLearningEventDerivedState,
  createPreparedLearningEvent,
  prepareLearningEvent,
} from '@/lib/learning';
import {
  buildRequestFingerprint,
  isRetryableReviewTransactionError,
  readOperationReplay,
  REVIEW_TRANSACTION_MAX_ATTEMPTS,
  SERIALIZABLE_REVIEW_TRANSACTION,
} from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { userIdCanAccessRequestedRotations } from '@/lib/personal-rotation-access';

export type VideoWatchReceipt = {
  videoId: string;
  watchedAt: string;
};

export type RecordVideoWatchResult =
  | { ok: true; deduped: boolean; receipt: VideoWatchReceipt }
  | { ok: false; status: number; error: string };

export async function recordVideoWatch(input: {
  userId: string;
  videoId: string;
  clientRequestId: string;
  quality?: number | null;
  responseTimeMs?: number | null;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  batchId?: string;
  now?: Date;
}): Promise<RecordVideoWatchResult> {
  // Resolve only routing metadata before any progress/event preparation. This
  // keeps an inaccessible personal video indistinguishable from a missing one.
  const videoAccess = await prisma.video.findFirst({
    where: { id: input.videoId, published: true, rightsStatus: 'cleared' },
    select: { rotation: true },
  });
  if (
    !videoAccess ||
    !await userIdCanAccessRequestedRotations(input.userId, [videoAccess.rotation ?? ''])
  ) {
    return { ok: false, status: 404, error: 'Video not found' };
  }

  const video = await prisma.video.findFirst({
    where: {
      id: input.videoId,
      published: true,
      rightsStatus: 'cleared',
      rotation: videoAccess.rotation,
    },
    select: {
      id: true,
      rotation: true,
      week: true,
      videoConcepts: { select: { conceptId: true } },
    },
  });
  if (!video) return { ok: false, status: 404, error: 'Video not found' };

  const now = input.now ?? new Date();
  const requestFingerprint = buildRequestFingerprint('video_watch', input.videoId, {
    quality: input.quality ?? null,
    responseTimeMs: input.responseTimeMs ?? null,
  });
  const prepared = await prepareLearningEvent({
    userId: input.userId,
    eventType: 'video_watched',
    sourceType: 'page',
    sourceId: input.videoId,
    quality: input.quality ?? undefined,
    responseMs: input.responseTimeMs ?? undefined,
    conceptIds: video.videoConcepts.map((link) => link.conceptId),
    rotation: video.rotation ?? undefined,
    week: video.week ?? undefined,
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
    },
    timestamp: now,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= REVIEW_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const receipt = await prisma.$transaction(async (tx) => {
        const operation = await tx.syncOperation.create({
          data: {
            userId: input.userId,
            clientOperationId: input.clientRequestId,
            operationType: 'video_watch',
            status: 'pending',
            requestFingerprint,
          },
          select: { id: true },
        });
        await tx.videoProgress.upsert({
          where: { userId_videoId: { userId: input.userId, videoId: input.videoId } },
          create: { userId: input.userId, videoId: input.videoId, watched: true, watchedAt: now },
          update: { watched: true, watchedAt: now },
        });
        await createPreparedLearningEvent(tx, prepared);
        const completed: VideoWatchReceipt = {
          videoId: input.videoId,
          watchedAt: now.toISOString(),
        };
        await tx.syncOperation.update({
          where: { id: operation.id },
          data: { status: 'completed', result: completed },
        });
        return completed;
      }, SERIALIZABLE_REVIEW_TRANSACTION);

      try {
        await applyLearningEventDerivedState(prepared);
      } catch (error) {
        logger.error('Failed to update derived video learning state', {
          userId: input.userId,
          videoId: input.videoId,
          error: String(error),
        });
      }
      return { ok: true, deduped: false, receipt };
    } catch (error) {
      lastError = error;
      if (!isRetryableReviewTransactionError(error)) throw error;
      const replay = await readOperationReplay<VideoWatchReceipt>({
        userId: input.userId,
        clientRequestId: input.clientRequestId,
        operationType: 'video_watch',
        requestFingerprint,
      });
      if (replay.kind === 'completed' && replay.result) {
        return { ok: true, deduped: true, receipt: replay.result };
      }
      if (replay.kind === 'conflict') {
        return { ok: false, status: 409, error: 'clientRequestId was already used for a different video watch' };
      }
      if (replay.kind === 'incomplete' || replay.kind === 'completed') {
        return { ok: false, status: 503, error: 'Video watch is still being recorded; retry with the same clientRequestId' };
      }
      if (attempt === REVIEW_TRANSACTION_MAX_ATTEMPTS) throw error;
    }
  }
  throw lastError ?? new Error('Video watch transaction failed');
}
