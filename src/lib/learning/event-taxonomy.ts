/**
 * What a `LearningEvent` row actually means.
 *
 * `LearningEvent` is not a grade log. It is the general telemetry table, and
 * `content_exposed` alone is ~76% of it. So `prisma.learningEvent.count({ where:
 * { userId } })` answers "how many telemetry rows does this person have", NOT
 * "how many questions did they answer" — the two differ by more than an order
 * of magnitude, and the first number looks entirely plausible as the second.
 *
 * That has now caused two wrong readings of the same kind: a user credited with
 * 833 answers in a day who had answered 15, and a new signup called a
 * "conversion" on 580 events of which 33 were answers.
 *
 * Use `answerEventWhere()` for any question along the lines of "is this person
 * actually studying". Use the class helpers when you need the other lanes.
 */

/**
 * A deliberate attempt at something, where the learner committed to an answer.
 * This is the set `record-event.ts` treats as a probe for ConceptState, and the
 * only set that belongs in an engagement or accuracy metric.
 */
export const ANSWER_EVENT_TYPES = [
  'card_reviewed',
  'mcq_attempted',
  'group_attempted',
  'assessment_attempted',
  'self_assessed',
] as const;

/**
 * The learner was SHOWN something. Necessary for spacing and exposure counts,
 * and never evidence of engagement: an item can be exposed and skipped.
 */
export const EXPOSURE_EVENT_TYPES = [
  'content_exposed',
  'page_read',
  'content_expanded',
  'video_watched',
] as const;

/**
 * Instrumentation about the app rather than the learner — session lifecycle,
 * cache builds, delivery health. Several of these are written by raw Prisma
 * calls that bypass `LearningEventType` in record-event.ts, which is why that
 * union is not a reliable inventory of what is in the table.
 */
export const DIAGNOSTIC_EVENT_TYPES = [
  'session_started',
  'session_ended',
  'target_crossed',
  'session_served',
  'session_cache_compute',
  'review_load',
  'offline_telemetry',
] as const;

export const KNOWN_EVENT_TYPES = [
  ...ANSWER_EVENT_TYPES,
  ...EXPOSURE_EVENT_TYPES,
  ...DIAGNOSTIC_EVENT_TYPES,
] as const;

export type AnswerEventType = (typeof ANSWER_EVENT_TYPES)[number];
export type EventClass = 'answer' | 'exposure' | 'diagnostic' | 'unknown';

export function classifyEventType(eventType: string): EventClass {
  if ((ANSWER_EVENT_TYPES as readonly string[]).includes(eventType)) return 'answer';
  if ((EXPOSURE_EVENT_TYPES as readonly string[]).includes(eventType)) return 'exposure';
  if ((DIAGNOSTIC_EVENT_TYPES as readonly string[]).includes(eventType)) return 'diagnostic';
  return 'unknown';
}

export function isAnswerEvent(eventType: string): boolean {
  return classifyEventType(eventType) === 'answer';
}

/**
 * Prisma `where` for answered events. Spread your own conditions in — the
 * eventType clause is applied last so it cannot be accidentally overwritten.
 */
export function answerEventWhere<T extends Record<string, unknown>>(rest?: T) {
  return { ...(rest ?? ({} as T)), eventType: { in: [...ANSWER_EVENT_TYPES] } };
}
