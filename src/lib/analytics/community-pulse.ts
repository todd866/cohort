/**
 * "Is anyone else using this today?" — an aggregate-only pulse.
 *
 * Deliberately not a per-user dashboard: it reports a count of people and a
 * count of reviews, never who or what. The viewer is excluded, because the
 * question being asked is about everyone else.
 *
 * Counts ANSWERS, not LearningEvent rows — see `src/lib/learning/event-taxonomy.ts`
 * for why the difference is about twentyfold.
 */
import { prisma } from '@/lib/prisma';
import { ANSWER_EVENT_TYPES } from '@/lib/learning/event-taxonomy';
import { startOfLocalDay } from './local-day';

export { startOfLocalDay };

export interface PulseStats {
  learners: number;
  reviews: number;
}

export const PULSE_TIMEZONE = process.env.MD3_TIMEZONE ?? 'Australia/Sydney';

export function describePulse(stats: PulseStats): string {
  if (stats.learners === 0) {
    if (stats.reviews !== 0) {
      throw new Error(
        `inconsistent pulse: ${stats.reviews} reviews with 0 learners — the viewer ` +
          'exclusion was applied to only one of the two counts',
      );
    }
    return 'No one else has studied yet today';
  }
  const who = stats.learners === 1 ? '1 other person' : `${stats.learners} other people`;
  return `${who} studying today · ${stats.reviews} review${stats.reviews === 1 ? '' : 's'}`;
}

/**
 * Reads today's answer events, excluding the viewer. Returns null on failure so
 * the caller can simply omit the line — this is a nice-to-have on a page that
 * must render regardless.
 */
export async function loadCommunityPulse(excludeUserId: string): Promise<PulseStats | null> {
  try {
    const since = startOfLocalDay(new Date(), PULSE_TIMEZONE);
    const rows = await prisma.learningEvent.groupBy({
      by: ['userId'],
      where: {
        timestamp: { gte: since },
        eventType: { in: [...ANSWER_EVENT_TYPES] },
        userId: { not: excludeUserId },
      },
      _count: { _all: true },
    });
    return {
      learners: rows.length,
      reviews: rows.reduce((sum, r) => sum + r._count._all, 0),
    };
  } catch {
    return null;
  }
}
