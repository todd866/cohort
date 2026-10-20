/** Generic dated teaching log. Institution calendars are supplied by callers. */
import { createHash } from 'node:crypto';
import { normalizeCurriculumTopic, TAUGHT_TOPIC_WINDOW_DAYS } from './teaching-pace';

export interface TaughtTopicEntry {
  rotation: string;
  /** YYYY-MM-DD in the course timezone. */
  date: string;
  topics: readonly string[];
}

const MS_PER_DAY = 86_400_000;

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
    if (!Number.isInteger(age) || age < 0 || age >= TAUGHT_TOPIC_WINDOW_DAYS) continue;
    for (const rawTopic of entry.topics) {
      const topic = normalizeCurriculumTopic(rawTopic);
      if (topic) ages.set(topic, Math.min(ages.get(topic) ?? Infinity, age));
    }
  }
  const topicRecencyDays = new Map([...ages].sort(([a], [b]) => a.localeCompare(b)));
  // Hash the whole rotation log so edits/removals invalidate queues too. Daily
  // ages expire/decay prepared queues even while they are otherwise servable stale.
  const teachingPaceFingerprint = log.length === 0 ? undefined : createHash('sha256')
    .update(JSON.stringify(['taught-topics-v1', TAUGHT_TOPIC_WINDOW_DAYS,
      log.map(entry => [entry.date, [...new Set(entry.topics.map(normalizeCurriculumTopic))].sort()]).sort(),
      [...topicRecencyDays],
    ])).digest('hex');
  return { topicRecencyDays, teachingPaceFingerprint };
}
