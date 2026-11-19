/** Generic dated teaching log. Institution calendars are supplied by callers. */
import { createHash } from 'node:crypto';
import { normalizeCurriculumTopic, TAUGHT_TOPIC_WINDOW_DAYS } from './teaching-pace';

export interface TaughtTopicEntry {
  rotation: string;
  /** YYYY-MM-DD in the course timezone. */
  date: string;
  topics: readonly string[];
  /** Optional preparation window, calculated by the offline session worklist. */
  leadDays?: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Days ahead of a dated session that its topics already lead the queue. Owner,
 * 2026-11-04: "we should automatically be ... serving must-know content" for the
 * day's mandatory sessions, so the morning check dates an entry on the session
 * day and the learner meets it the day before as well as after.
 */
export const TAUGHT_TOPIC_LEAD_DAYS = 1;

/** courseDay is the course's local date represented at UTC midnight. */
export function resolveTaughtTopics(
  entries: readonly TaughtTopicEntry[],
  rotation: string,
  courseDay: Date,
): { topicRecencyDays: ReadonlyMap<string, number>; teachingPaceFingerprint: string | undefined } {
  const log = entries.filter(entry => entry.rotation === rotation);
  const ages = new Map<string, number>();
  for (const entry of log) {
    const age = (courseDay.getTime() - Date.parse(`${entry.date}T00:00:00Z`)) / MS_PER_DAY;
    if (!Number.isInteger(age) || age < -Math.max(TAUGHT_TOPIC_LEAD_DAYS, Number.isFinite(entry.leadDays) ? Math.ceil(entry.leadDays!) : TAUGHT_TOPIC_LEAD_DAYS) || age >= TAUGHT_TOPIC_WINDOW_DAYS) continue;
    // Before the session counts as the day itself: full strength.
    const effectiveAge = Math.max(0, age);
    for (const rawTopic of entry.topics) {
      const topic = normalizeCurriculumTopic(rawTopic);
      if (topic) ages.set(topic, Math.min(ages.get(topic) ?? Infinity, effectiveAge));
    }
  }
  const topicRecencyDays = new Map([...ages].sort(([a], [b]) => a.localeCompare(b)));
  // Hash the whole rotation log so edits/removals invalidate queues too. Daily
  // ages expire/decay prepared queues even while they are otherwise servable stale.
  const teachingPaceFingerprint = log.length === 0 ? undefined : createHash('sha256')
    .update(JSON.stringify(['taught-topics-v1', TAUGHT_TOPIC_WINDOW_DAYS,
      log.map(entry => [entry.date, entry.leadDays ?? TAUGHT_TOPIC_LEAD_DAYS, [...new Set(entry.topics.map(normalizeCurriculumTopic))].sort()]).sort(),
      [...topicRecencyDays],
    ])).digest('hex');
  return { topicRecencyDays, teachingPaceFingerprint };
}
