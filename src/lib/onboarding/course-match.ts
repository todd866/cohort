/**
 * "Something else" on the rotation chooser: a visitor describes their course in
 * their own words. When that description names exactly one specialty md3
 * teaches as a rotation, offer it, so they start on the closest fit at once
 * instead of on the first scheduled rotation (owner direction, 24 Oct 2026).
 *
 * This only proposes. The visitor confirms with a tap, so no enrolment is ever
 * guessed from prose, and an ambiguous or generic description offers nothing.
 * A deterministic keyword match, not a model: the text is untrusted input.
 */
export type CourseMatch = { kind: 'rotation'; rotation: string } | { kind: 'usmle' };

const ROTATION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['cah', /\b(?:paed\w*|pa?ediatric\w*|peds|child(?:ren)?|child health|neonat\w*|adolescent\w*)\b/i],
  ['pwh', /(?:\bo\s?&\s?g\b|\bob\/?gyn\w*|\bobstetric\w*|\bgyna?ecolog\w*|\bwomen'?s health\b|\bpregnan\w*|\bmidwi\w*|\bperinatal\b|\branzcog\b|\bdranzcog\b)/i],
  ['paam', /\b(?:psychiatr\w*|mental health|addiction\w*)\b/i],
  ['critical-care', /\b(?:icu|intensive care|critical care|emergency|anaesth\w*|anesth\w*)\b/i],
];

const USMLE = /\b(?:usmle|step\s?1|nbme|comlex)\b/i;

export function matchCourseDescription(text: string, rotations: readonly string[]): CourseMatch | null {
  if (USMLE.test(text)) return { kind: 'usmle' };
  const hits = ROTATION_PATTERNS.filter(([rotation, pattern]) => rotations.includes(rotation) && pattern.test(text));
  return hits.length === 1 ? { kind: 'rotation', rotation: hits[0][0] } : null;
}
