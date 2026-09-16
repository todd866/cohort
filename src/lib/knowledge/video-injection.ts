/**
 * Video Injection — Surface videos for weak concepts in study sessions
 *
 * Follows the same pattern as snippet-injection.ts:
 * Inserts a video item before the first card/question for a weak concept
 * when the student hasn't watched it recently.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { UnifiedSessionItem } from './unified-scheduler';

type StateEntry = { recallProbability: number; exposureCount: number };

const RECALL_THRESHOLD = 0.5; // Only inject for concepts below this recall
const RECENT_WATCH_DAYS = 7; // Don't re-show videos watched within this window

/**
 * Inject video items before cards/questions for weak concepts.
 *
 * 1. Find concepts where recallOnExamDay < 0.5
 * 2. Batch fetch primary VideoConcept entries for those concepts
 * 3. Exclude videos watched in last 7 days
 * 4. Insert video item before first card/question for that concept
 * 5. Return augmented items list
 */
export async function injectVideoItems(
  items: UnifiedSessionItem[],
  stateMap: Map<string, StateEntry>,
  userId: string,
  maxVideos: number = 1
): Promise<UnifiedSessionItem[]> {
  // Find weak concept IDs from items
  const weakConceptIds: string[] = [];
  const seenConcepts = new Set<string>();

  for (const item of items) {
    if (seenConcepts.has(item.conceptId)) continue;
    seenConcepts.add(item.conceptId);

    const state = stateMap.get(item.conceptId);
    const recall = state?.recallProbability ?? 0;

    if (recall < RECALL_THRESHOLD) {
      weakConceptIds.push(item.conceptId);
    }
  }

  if (weakConceptIds.length === 0) return items;

  // Batch fetch primary videos for weak concepts
  let videoLinks: Array<{
    videoId: string;
    conceptId: string;
    video: {
      id: string;
      title: string;
      thumbnailR2Key: string | null;
      durationSecs: number;
      r2Key: string;
      creatorName: string;
    };
  }>;

  try {
    videoLinks = await prisma.videoConcept.findMany({
      where: {
        conceptId: { in: weakConceptIds },
        isPrimary: true,
        video: { published: true, rightsStatus: 'cleared' },
      },
      select: {
        videoId: true,
        conceptId: true,
        video: {
          select: {
            id: true,
            title: true,
            thumbnailR2Key: true,
            durationSecs: true,
            r2Key: true,
            creatorName: true,
          },
        },
      },
    });
  } catch (err) {
    logger.error('Failed to fetch video concepts', { error: String(err) });
    return items;
  }

  if (videoLinks.length === 0) return items;

  // Exclude videos watched in last N days
  const videoIds = videoLinks.map((l) => l.video.id);
  const cutoff = new Date(Date.now() - RECENT_WATCH_DAYS * 24 * 60 * 60 * 1000);

  let recentlyWatched = new Set<string>();
  try {
    const watched = await prisma.videoProgress.findMany({
      where: {
        userId,
        videoId: { in: videoIds },
        watched: true,
        watchedAt: { gte: cutoff },
      },
      select: { videoId: true },
    });
    recentlyWatched = new Set(watched.map((w) => w.videoId));
  } catch (err) {
    logger.error('Failed to fetch video progress', { error: String(err) });
    // Continue without exclusion — safe fallback
  }

  // Build concept → video map (one per concept, skip recently watched)
  const videoByConceptId = new Map<string, typeof videoLinks[0]>();
  for (const link of videoLinks) {
    if (recentlyWatched.has(link.video.id)) continue;
    if (!videoByConceptId.has(link.conceptId)) {
      videoByConceptId.set(link.conceptId, link);
    }
  }

  if (videoByConceptId.size === 0) return items;

  // Walk items and insert video before first item for each weak concept
  const result: UnifiedSessionItem[] = [];
  const injectedConcepts = new Set<string>();
  let videoCount = 0;

  for (const item of items) {
    if (
      videoCount < maxVideos &&
      !injectedConcepts.has(item.conceptId) &&
      videoByConceptId.has(item.conceptId)
    ) {
      const link = videoByConceptId.get(item.conceptId)!;
      injectedConcepts.add(item.conceptId);
      videoCount++;

      result.push({
        type: 'video',
        id: link.video.id,
        conceptId: item.conceptId,
        conceptName: item.conceptName,
        priority: item.priority,
        interventionReason: 'weak_recall',
        videoTitle: link.video.title,
        videoThumbnailUrl: link.video.thumbnailR2Key,
        videoDuration: link.video.durationSecs,
        videoR2Key: link.video.r2Key,
        creatorName: link.video.creatorName,
      } as UnifiedSessionItem);
    }

    result.push(item);
  }

  return result;
}
