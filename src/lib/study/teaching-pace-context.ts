/**
 * Resolving the curriculum-pacing signal once, for every path that schedules.
 *
 * Pacing needs two things the scheduler cannot see: which teaching week the
 * student's block is in, and which week introduces each topic. Both depend on
 * the student's track and their institution's calendar, so they are resolved
 * here — server-side, from the authenticated user — and handed down as a plain
 * number and a plain string→number map.
 *
 * WHY THIS IS SHARED. The live request path and the background cache-refresh
 * path both build sessions, and most delivered items come from the cache. When
 * only the live path passed a teaching week, cache-built sessions were paced
 * against nothing and the two paths quietly disagreed about what to serve. One
 * resolver, used by both, is what stops that drift recurring.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getBlockStartDate, courseCalendarDay, type TrackNumber } from '@/lib/rotation-context';
import { currentTeachingWeek as currentTeachingWeekFor } from '@/lib/curriculum/teaching-pace';
import { buildTopicTeachingWeekMap } from '@/lib/curriculum/teaching-topic-week';

export interface TeachingPace {
  /** Teaching week the block is in, or null for no signal. */
  currentTeachingWeek: number | null;
  /** Topic slug → the teaching week that introduces it. Empty means no signal. */
  topicTeachingWeeks: ReadonlyMap<string, number>;
}

const NO_PACE: TeachingPace = { currentTeachingWeek: null, topicTeachingWeeks: new Map() };

function isTrackNumber(value: unknown): value is TrackNumber {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 4;
}

/**
 * Pacing for a rotation and a known track.
 *
 * A missing or invalid track, an unscheduled rotation, or a date before the
 * block starts all yield a null week, which every consumer treats as "no
 * signal" rather than "week zero". The topic map is independent of the track,
 * so it is still returned — it costs nothing and is inert without a week.
 */
export function resolveTeachingPace(rotation: string, track: unknown, now = new Date()): TeachingPace {
  const topicTeachingWeeks = buildTopicTeachingWeekMap(rotation);
  if (!isTrackNumber(track)) return { currentTeachingWeek: null, topicTeachingWeeks };
  const blockStart = getBlockStartDate(rotation, track);
  return {
    currentTeachingWeek: blockStart
      ? currentTeachingWeekFor(blockStart, courseCalendarDay(now))
      : null,
    topicTeachingWeeks,
  };
}

/**
 * Pacing for a user whose track has not already been loaded.
 *
 * Used by the background cache refresh, which has a userId and nothing else.
 * Fails soft: a lookup error costs the pacing signal for that build, never the
 * build itself.
 */
export async function loadTeachingPaceForUser(
  userId: string,
  rotation: string,
  now = new Date(),
): Promise<TeachingPace> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { track: true },
    });
    return resolveTeachingPace(rotation, user?.track, now);
  } catch (error) {
    logger.warn('Failed to resolve teaching pace; scheduling without it', {
      userId,
      rotation,
      error: String(error),
    });
    return NO_PACE;
  }
}
