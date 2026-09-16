/**
 * Building the topic → teaching-week map the scheduler paces against.
 *
 * This is the one place that reads the institution's timetable for pacing
 * purposes. What leaves it is a `Map<string, number>` of neutral slugs to week
 * numbers, which is what crosses into the ranker — the calendar itself stays
 * behind this boundary, matching the discipline in `teaching-pace.ts`.
 *
 * WHY TOPICS AND NOT FILENAMES. `teachingWeekForSourceFile` translates md3's
 * `weekN-` filing into a teaching week, but that filing is a whole-file
 * granularity: `week5-cardio-derm-endo` is one week for cardiology, dermatology
 * and endocrinology alike, and CAH teaches those in weeks 3, 3 and 3 only by
 * luck. Topics are what the course actually schedules, and both cards and
 * questions already carry them, so pacing off topics is both finer and
 * available on question rows that have no `sourceFile` at all.
 */

import { normalizeCurriculumTopic } from './teaching-pace';
import { USYD_MD3_2026 } from './usyd-md3-2026';
import {
  USYD_MD3_2026_TOPIC_ALIAS_ARTIFACT,
  type ReviewedMd3Rotation,
} from './usyd-md3-2026-topic-aliases';

const EMPTY: ReadonlyMap<string, number> = new Map();

function isReviewedRotation(rotation: string): rotation is ReviewedMd3Rotation {
  return rotation in USYD_MD3_2026_TOPIC_ALIAS_ARTIFACT.groups;
}

/**
 * Every topic slug and reviewed alias for `rotation`, mapped to the teaching
 * week that introduces it.
 *
 * Earliest week wins on collision. An alias group can point at a canonical
 * topic taught in more than one week, and a topic first taught in week 1 should
 * not be treated as week-3 material because it recurs.
 *
 * Topics belonging to no `WeekDefinition` — cross-block theme pages, CRS cases,
 * practical skills — are deliberately absent. They are taught throughout, so
 * they carry no pacing signal and callers read their absence as neutral.
 *
 * Cheap enough to call per session (tens of entries, no I/O), and memoised per
 * rotation so repeated calls in one process share the work.
 */
const CACHE = new Map<string, ReadonlyMap<string, number>>();

export function buildTopicTeachingWeekMap(rotation: string): ReadonlyMap<string, number> {
  const cached = CACHE.get(rotation);
  if (cached) return cached;
  const built = computeTopicTeachingWeekMap(rotation);
  CACHE.set(rotation, built);
  return built;
}

function computeTopicTeachingWeekMap(rotation: string): ReadonlyMap<string, number> {
  if (!isReviewedRotation(rotation)) return EMPTY;

  const map = new Map<string, number>();
  const add = (rawTopic: string, week: number): void => {
    const key = normalizeCurriculumTopic(rawTopic);
    if (!key) return;
    const existing = map.get(key);
    if (existing === undefined || week < existing) map.set(key, week);
  };

  const canonicalWeek = new Map<string, number>();
  for (const week of USYD_MD3_2026.weeks) {
    if (week.block !== rotation) continue;
    for (const topic of week.topics) {
      const existing = canonicalWeek.get(topic);
      if (existing === undefined || week.number < existing) canonicalWeek.set(topic, week.number);
      add(topic, week.number);
    }
  }

  if (canonicalWeek.size === 0) return EMPTY;

  for (const group of USYD_MD3_2026_TOPIC_ALIAS_ARTIFACT.groups[rotation]) {
    const week = canonicalWeek.get(group.canonicalTopic);
    if (week === undefined) continue;
    for (const alias of group.aliases) add(alias, week);
  }

  return map;
}
