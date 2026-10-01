import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { getSignedVideoUrl } from '@/lib/video-storage';
import type { UnifiedItem } from './unified-session-types';
import type { CommitmentLevel } from '@/lib/commitment';
import { meetsRequiredTier } from '@/lib/content-access';

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVideoShapedItem(value: unknown): value is JsonRecord & { type: 'video' } {
  return isJsonRecord(value) && value.type === 'video';
}

function hasValidVideoId(
  value: JsonRecord & { type: 'video' },
): value is JsonRecord & UnifiedItem & { type: 'video'; id: string } {
  return typeof value.id === 'string' && value.id.trim().length > 0;
}

/**
 * Mint private video URLs at the final unified-session response boundary.
 *
 * Session caches deliberately retain only stable IDs/raw object keys. This
 * function re-checks the current database rights state, signs the database's
 * keys (never a cached/client key), and removes raw keys from the response. A
 * stale/revoked row or signing failure drops only that video; the rest of the
 * learning session remains usable.
 */
export async function withPrivateVideoDelivery(
  response: NextResponse,
  commitmentLevel: CommitmentLevel,
): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  if (!isJsonRecord(payload) || !Array.isArray(payload.items)) return response;

  const videoItems = payload.items.filter(isVideoShapedItem);
  if (videoItems.length === 0) return response;
  const requestedVideoIds = [...new Set(
    videoItems.filter(hasValidVideoId).map((item) => item.id),
  )];

  let videos: Array<{
    id: string;
    r2Key: string;
    thumbnailR2Key: string | null;
    requiredTier: string;
  }> = [];
  if (requestedVideoIds.length > 0) {
    try {
      videos = await prisma.video.findMany({
        where: {
          id: { in: requestedVideoIds },
          published: true,
          rightsStatus: 'cleared',
        },
        select: {
          id: true,
          r2Key: true,
          thumbnailR2Key: true,
          requiredTier: true,
        },
      });
    } catch (error) {
      logger.error('Private video authorization lookup failed', {
        requestedVideoCount: requestedVideoIds.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const accessibleVideos = videos.filter((video) =>
    meetsRequiredTier(commitmentLevel, video.requiredTier),
  );
  const deliveryEntries = await Promise.all(accessibleVideos.map(async (video) => {
    try {
      const [videoUrl, videoThumbnailUrl] = await Promise.all([
        getSignedVideoUrl(video.r2Key),
        video.thumbnailR2Key ? getSignedVideoUrl(video.thumbnailR2Key) : Promise.resolve(null),
      ]);
      return [video.id, { videoUrl, videoThumbnailUrl }] as const;
    } catch (error) {
      logger.error('Private video signing failed', {
        videoId: video.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }));
  const deliveries = new Map(
    deliveryEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  );

  const deliveredItems = payload.items.flatMap((item) => {
    if (!isVideoShapedItem(item)) return [item];
    if (!hasValidVideoId(item)) return [];
    const delivery = deliveries.get(item.id);
    if (!delivery) return [];

    const delivered: UnifiedItem = {
      ...item,
      videoUrl: delivery.videoUrl,
      videoThumbnailUrl: delivery.videoThumbnailUrl,
    };
    delete delivered.videoR2Key;
    return [delivered];
  });

  const deliveredVideoCount = videoItems.filter(
    (item) => hasValidVideoId(item) && deliveries.has(item.id),
  ).length;
  const droppedVideoCount = videoItems.length - deliveredVideoCount;
  if (droppedVideoCount > 0) {
    logger.warn('Dropped non-deliverable unified-session videos', {
      requestedVideoCount: videoItems.length,
      deliveredVideoCount,
      droppedVideoCount,
    });
  }

  const nextPayload: JsonRecord = { ...payload, items: deliveredItems };
  if (isJsonRecord(payload.stats)) {
    nextPayload.stats = {
      ...payload.stats,
      totalItems: deliveredItems.length,
    };
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'private, no-store');

  return NextResponse.json(nextPayload, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
