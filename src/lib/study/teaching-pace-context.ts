/**
 * Resolving the curriculum-pacing signal once, for every path that schedules.
 *
 * Weekly pacing needs the student's block week and each topic's teaching week.
 * Dated lecture pacing needs only the course day and the rotation's static log;
 * it applies independently of track. Both are resolved here server-side and
 * handed down as neutral numbers/maps, keeping the calendar out of ranking.
 *
 * WHY THIS IS SHARED. The live request path and the background cache-refresh
 * path both build sessions, and most delivered items come from the cache. When
 * only the live path passed a teaching week, cache-built sessions were paced
 * against nothing and the two paths quietly disagreed about what to serve. One
 * resolver, used by both, is what stops that drift recurring.
 */

import {withSimulationLearningFocus} from '@/lib/simulation/learning-cycle';
import { resolveSimulationFocus } from './simulation-focus.server';
import type { SimulationFocus } from './simulation-focus';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getBlockStartDate, courseCalendarDay, type TrackNumber } from '@/lib/rotation-context';
import { currentTeachingWeek as currentTeachingWeekFor } from '@/lib/curriculum/teaching-pace';
import { buildDatedTeachingPace, buildTopicTeachingWeekMap } from '@/lib/curriculum/teaching-topic-week';

export interface TeachingPace {
  simulationFocus?: SimulationFocus | null;
  /** Topic slug → course calendar days since its most recent lecture. */
  topicRecencyDays: ReadonlyMap<string, number>;
  /** Rotation log and daily decay state used to validate prepared queues. */
  teachingPaceFingerprint?: string;
  /** Teaching week the block is in, or null for no signal. */
  currentTeachingWeek: number | null;
  /** Topic slug → the teaching week that introduces it. Empty means no signal. */
  topicTeachingWeeks: ReadonlyMap<string, number>;
}

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
 * Dated lectures apply to everyone reviewing the rotation, regardless of track.
 */
export function resolveTeachingPace(rotation: string, track: unknown, now = new Date(), email?: string | null, simulationGoal?:unknown, feedProfile?:unknown): TeachingPace {
  const topicTeachingWeeks = buildTopicTeachingWeekMap(rotation);
  const courseDay = courseCalendarDay(now);
  const dated = { ...buildDatedTeachingPace(rotation, courseDay), simulationFocus: withSimulationLearningFocus(resolveSimulationFocus(email, rotation, now, simulationGoal),feedProfile,rotation,now,simulationGoal) };
  if (!isTrackNumber(track)) return { currentTeachingWeek: null, topicTeachingWeeks, ...dated };
  const blockStart = getBlockStartDate(rotation, track);
  return {
    currentTeachingWeek: blockStart
      ? currentTeachingWeekFor(blockStart, courseDay)
      : null,
    topicTeachingWeeks,
    ...dated,
  };
}

/**
 * Pacing for a user whose track has not already been loaded.
 *
 * Used by the background cache refresh, which has a userId and nothing else.
 * Fails soft: a lookup error costs weekly pacing, never dated lectures or the
 * build itself. The dated signal needs no database lookup.
 */
export async function loadTeachingPaceForUser(
  userId: string,
  rotation: string,
  now = new Date(),
): Promise<TeachingPace> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { track: true, email: true, simulationGoal:true, feedProfile:true },
    });
    return resolveTeachingPace(rotation, user?.track, now, user?.email,user?.simulationGoal,user?.feedProfile);
  } catch (error) {
    logger.warn('Failed to resolve teaching pace; scheduling without weekly pacing', {
      userId,
      rotation,
      error: String(error),
    });
    return { ...resolveTeachingPace(rotation, null, now), topicTeachingWeeks: new Map() };
  }
}
