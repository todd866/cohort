/**
 * The first-year (USyd MD1) learner program. Client-safe and pure.
 *
 * An MD1 learner is `User.institution === 'usyd-md1'`, the value the
 * institution model already defines (src/lib/institution.ts). Every surface
 * that differs for them asks `isMd1Program` rather than keeping its own list,
 * so the review menu, nav, clinical audience, exams panel and settings cannot
 * disagree about who is a first-year.
 *
 * Owner, 2026-10-21: "make a holistically good site for these MD1s". The study
 * container is one shared deck (MD1_DECK, explicit focus, owner-gated in the
 * personal-deck registry); the exams are KAT4, the MMCA and AHCT 4.
 */

export const MD1_INSTITUTION = 'usyd-md1';

/** The shared first-year deck. Its access is decided by the personal-deck registry, never here. */
export const MD1_DECK = 'md1-foundations';

/** Subject decks an MD1 learner's review menu offers before they customise it. */
export const MD1_REVIEW_MENU_SUBJECTS: readonly string[] = ['physical-exam', 'anatomy'];

/**
 * Top-level routes that hold only Year 3 material (the CAH textbook and the
 * rotation practice papers). The nav hides them for MD1; the routes stay open.
 */
export const MD1_HIDDEN_NAV_HREFS: readonly string[] = ['/textbook', '/practice-exams'];

export interface Md1Exam {
  /**
   * The UserRotation key a personal date is stored under. KAT4 uses the deck
   * slug so the scheduler's exam pacing for the deck sees the same date.
   */
  id: string;
  short: string;
}

/**
 * The exams the MD1 deck prepares for. No dates: the 2026 MD1 dates are not on
 * file (the academic planner covers January to June only), so a date exists
 * only when the learner sets one.
 */
export const MD1_EXAMS: readonly Md1Exam[] = [
  { id: MD1_DECK, short: 'KAT4' },
  { id: 'md1-mmca', short: 'MMCA' },
  // Anatomy and Histology Competency Test 4: 12 timed prosection and slide
  // stations, written identification (2024: 18 November). Added 2026-10-22.
  { id: 'md1-ahct', short: 'AHCT4' },
];

export function isMd1Program(institution: string | null | undefined): boolean {
  return institution === MD1_INSTITUTION;
}
