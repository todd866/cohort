/**
 * Pacing content against the week the course actually teaches it.
 *
 * The scheduler otherwise has no idea what has been taught. It walks the
 * manifold toward the exam-target gap, which is right for the whole block but
 * wrong on any given Tuesday: in CAH week 1 it will happily serve week-4
 * orthopaedics the student has not met, which reads as noise rather than
 * revision and burns a first exposure at the worst moment.
 *
 * DIRECTION OF THE FIX. Not-yet-taught material is SUNK, never excluded. Two
 * reasons. Reading ahead is legitimate and some students deliberately do it. And
 * a hard filter starves the queue for anyone who has already covered what has
 * been taught — the un-starve fix in commit d7f20666 exists because that
 * failure has happened before. A capped penalty degrades gracefully where a
 * filter fails hard.
 *
 * Already-taught material gets no bonus. It does not need one: sinking the
 * not-yet-taught already floats it, and adding a bonus on top would compete
 * with the failure-escalation and ladder boosts that carry more signal.
 *
 * The penalty is capped at three steps so week-7 material in week 1 is
 * discouraged rather than unreachable.
 */

/** One step of "not taught yet", sized below importanceBoost's -10..-3 band. */
export const PACING_AHEAD_PENALTY = 3;
const MAX_STEPS = 3;

/** Teaching weeks in a Year 3 block; past this, the block is over. */
const BLOCK_WEEKS = 7;

/**
 * Positive sinks, zero is neutral. Both arguments may be null — PWH has no
 * teaching weeks, content outside the `weekN-` convention has no content week,
 * and dates before the block start have no current week. Any of those means
 * "no signal", which must be neutral rather than penalised.
 */
export function curriculumPacingBoost(
  itemTeachingWeek: number | null | undefined,
  currentWeek: number | null | undefined,
): number {
  if (itemTeachingWeek == null || currentWeek == null) return 0;
  // Past the end of the block everything is revision; nothing is "ahead".
  if (currentWeek > BLOCK_WEEKS) return 0;
  const stepsAhead = itemTeachingWeek - currentWeek;
  if (stepsAhead <= 0) return 0;
  return Math.min(stepsAhead, MAX_STEPS) * PACING_AHEAD_PENALTY;
}

/**
 * The other half of pacing: float what the course is teaching RIGHT NOW.
 *
 * Sinking the not-yet-taught says nothing about which of the already-taught
 * weeks a student is currently sitting in lectures for. In CAH week 1 the
 * penalty above is happy to serve week-1 and week-4 material alike once week 4
 * is capped — but only one of those is being taught this week, and that is the
 * one the student wants to meet on Tuesday afternoon.
 *
 * Two steps, both small. The current week floats hardest; last week gets half
 * that, because material taught days ago is still consolidating and is what a
 * student is most likely to be revising alongside the new lectures. Anything
 * older is left alone — it is already in the spaced-repetition rotation, and
 * lifting it would compete with the failure-escalation and ladder boosts that
 * carry more signal about what this particular student needs.
 *
 * Sized against `variantBoost` (4) and under `importanceBoost` (-10/-3), so it
 * reorders within a concept's pool without overriding the pedagogical ordering
 * that sits above it.
 */
export const PACING_CURRENT_WEEK_BOOST = 4;
export const PACING_LAST_WEEK_BOOST = 2;

export function curriculumRecencyBoost(
  itemTeachingWeek: number | null | undefined,
  currentWeek: number | null | undefined,
): number {
  if (itemTeachingWeek == null || currentWeek == null) return 0;
  // Once the block is over nothing is "current" — the whole syllabus is
  // revision, and pinning the last teaching week to the top through the run-up
  // to the exam would be exactly wrong.
  if (currentWeek > BLOCK_WEEKS) return 0;
  if (itemTeachingWeek === currentWeek) return -PACING_CURRENT_WEEK_BOOST;
  if (itemTeachingWeek === currentWeek - 1) return -PACING_LAST_WEEK_BOOST;
  // The future belongs to curriculumPacingBoost; handling it here too would
  // stack two rules on the same item.
  return 0;
}

/**
 * The same rule at concept scale.
 *
 * This is the higher-leverage half. Card and question ranking only reorder
 * within a concept's pool; concept priority decides which concepts the session
 * walks at all, so a week-4 concept that never gets picked cannot be rescued by
 * any amount of within-pool reordering.
 *
 * Additive on the priority axis, where HIGHER is more urgent — hence the
 * opposite sign to the rank boosts above. Sized to sit above `likedBoost`
 * (0.15) and below `recentFailureBoost` (0.25): what the course is teaching
 * this week outranks a standing preference, and yields to a concept the student
 * failed an hour ago.
 */
export const CADENCE_CURRENT_WEEK_BOOST = 0.2;
export const CADENCE_LAST_WEEK_BOOST = 0.1;

export function teachingCadenceConceptBoost(
  conceptTeachingWeek: number | null | undefined,
  currentWeek: number | null | undefined,
): number {
  if (conceptTeachingWeek == null || currentWeek == null) return 0;
  if (currentWeek > BLOCK_WEEKS) return 0;
  if (conceptTeachingWeek === currentWeek) return CADENCE_CURRENT_WEEK_BOOST;
  if (conceptTeachingWeek === currentWeek - 1) return CADENCE_LAST_WEEK_BOOST;
  return 0;
}
