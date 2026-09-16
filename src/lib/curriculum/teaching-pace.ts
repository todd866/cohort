/**
 * Translating md3's content week into the week the course actually teaches it.
 *
 * md3 files content by its own week numbering, baked into the MDX filename and
 * — crucially — into `computeStableId`. Renumbering to match Canvas would churn
 * every card id in the rotation and orphan its review history, so the two
 * numberings are allowed to disagree and this module translates between them.
 *
 * The disagreement is real and specific to CAH. Canvas delivers that whole
 * syllabus across teaching weeks 1-4 (week 5 is structured teaching, 6-7 are
 * attachments), while md3 spreads the same material over content weeks 1-7 in a
 * different order. Pacing off the md3 number puts a student studying cardiology
 * in their week 5 when the course taught it in week 3, and — worse — leaves
 * week-4 Canvas material unsurfaced until md3 week 7, by which time everything
 * has been examinable for three weeks.
 *
 * Critical Care already agrees, so its mapping is the identity. PWH has no
 * teaching weeks at all (Canvas organises it by domain), so it has no mapping
 * and callers must treat null as "no pacing signal", never as week 0.
 */

/** md3 content week from an MDX stem, e.g. `week5-cardio-derm-endo` → 5. */
export function contentWeekFromSourceFile(sourceFile: string | null | undefined): number | null {
  if (!sourceFile) return null;
  const match = /^week(\d+)(?:[-.]|$)/.exec(sourceFile);
  if (!match) return null;
  const week = Number(match[1]);
  return Number.isInteger(week) && week > 0 ? week : null;
}

/**
 * md3 content week → Canvas teaching week, per rotation.
 *
 * CAH's pairs are read off the two sources rather than derived: md3 weeks 1-2
 * are Canvas week 1, 3-4 are week 2, 5-6 are week 3, 7 is week 4. A rotation
 * absent from this map and present in the curriculum weeks is the identity; a
 * rotation with no teaching weeks at all yields null.
 */
const CONTENT_TO_TEACHING: Record<string, Record<number, number>> = {
  cah: { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4 },
};

/**
 * Rotations whose course is organised by teaching week at all. PWH is
 * deliberately absent — Canvas organises it by domain, so it has no weekly
 * pacing signal and callers must read null as "no signal", never as week 0.
 *
 * Listed literally rather than derived from the curriculum definition: this
 * module ships in the public distribution, which must not import any
 * institution's calendar. The rotation ids are neutral strings; the calendar
 * they refer to stays private.
 */
const HAS_TEACHING_WEEKS = new Set(['critical-care', 'paam', 'cah']);

export function teachingWeekForSourceFile(
  rotation: string,
  sourceFile: string | null | undefined,
): number | null {
  if (!HAS_TEACHING_WEEKS.has(rotation)) return null;
  const contentWeek = contentWeekFromSourceFile(sourceFile);
  if (contentWeek === null) return null;
  const mapped = CONTENT_TO_TEACHING[rotation];
  return mapped ? mapped[contentWeek] ?? null : contentWeek;
}

/**
 * Raw content tag → the slug vocabulary the curriculum is written in.
 *
 * Content banks tag freely ("Allergy & Immunodeficiency", " Child Protection ")
 * while the curriculum uses lower-kebab slugs. One definition lives here so the
 * alias artifact and the ranking layer cannot drift into two normalisations and
 * silently stop matching each other.
 */
export function normalizeCurriculumTopic(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The week the course teaches an item, from its topic tags.
 *
 * `topicWeeks` is a plain map of neutral slug → week number, built by the
 * caller from the institution's curriculum. Passing it in rather than importing
 * the calendar keeps this module — and everything downstream of it in the
 * ranker — free of any institution's timetable, the same discipline
 * `currentTeachingWeek` follows by taking a bare number.
 *
 * An item tagged with several topics resolves to the EARLIEST of them: it has
 * been met once any one of its topics has been taught, and treating it as
 * not-yet-taught because a secondary tag is taught later would sink material
 * the student has already sat through.
 *
 * Unresolvable tags are skipped, and an item where nothing resolves returns
 * null — "no signal", never "not taught". Imported decks carry vocabulary the
 * curriculum has never heard of, and penalising them would quietly shrink the
 * queue.
 */
export function teachingWeekForTopics(
  topics: readonly string[] | null | undefined,
  topicWeeks: ReadonlyMap<string, number> | null | undefined,
): number | null {
  if (!topics || !topicWeeks || topicWeeks.size === 0) return null;
  let earliest: number | null = null;
  for (const topic of topics) {
    const week = topicWeeks.get(normalizeCurriculumTopic(topic));
    if (week === undefined) continue;
    if (earliest === null || week < earliest) earliest = week;
  }
  return earliest;
}

/**
 * The teaching week for one servable item, topics first and filing second.
 *
 * The course calendar is the authority on when something is taught. md3's own
 * `weekN-` filing is a proxy for it — a good one where the two agree, a poor
 * one for CAH where they do not — so it is consulted only when no topic
 * resolves.
 */
export function itemTeachingWeek(
  rotation: string,
  sourceFile: string | null | undefined,
  topics: readonly string[] | null | undefined,
  topicWeeks: ReadonlyMap<string, number> | null | undefined,
): number | null {
  return teachingWeekForTopics(topics, topicWeeks)
    ?? teachingWeekForSourceFile(rotation, sourceFile);
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Which teaching week a date falls in, counting from the block start.
 *
 * Deliberately unclamped at the top: a student revising in October is in
 * "week 9", not pinned at week 7, so post-block revision is not mistaken for
 * being mid-block. Returns null before the block starts, so nothing is treated
 * as already taught.
 */
export function currentTeachingWeek(blockStart: Date, now: Date): number | null {
  const elapsed = now.getTime() - blockStart.getTime();
  if (elapsed < 0) return null;
  return Math.floor(elapsed / MS_PER_WEEK) + 1;
}
