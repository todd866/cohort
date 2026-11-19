/**
 * The first-run "which year are you in" answer, and the one place that says
 * what each year is served. Client-safe and pure.
 *
 * MD1 and MD2 are complete in one tap, so each maps to an institution plus a
 * fixed module set. MD3 and MD4 need a rotation pick next (the four scheduled
 * blocks), after which the rotation route derives modules and track as before.
 *
 * To extend a year's content, edit `modulesForYear` and nothing else: the
 * route, the serving tests and the picker all read it.
 */
import { MD1_DECK, MD1_INSTITUTION, MD1_REVIEW_MENU_SUBJECTS } from '@/lib/md1-program';
import { MD2_ACTIVE_MODULES, MD2_INSTITUTION } from '@/lib/md2-program';

export const STUDY_YEARS = ['md1', 'md2', 'md3', 'md4'] as const;
export type StudyYear = (typeof STUDY_YEARS)[number];

export const YEAR_LABEL: Readonly<Record<StudyYear, string>> = {
  md1: 'MD1',
  md2: 'MD2',
  md3: 'MD3',
  md4: 'MD4',
};

/** MD1: the shared first-year deck plus its subject decks. */
export const MD1_MODULES: readonly string[] = Object.freeze([MD1_DECK, ...MD1_REVIEW_MENU_SUBJECTS]);

export function isStudyYear(value: unknown): value is StudyYear {
  return typeof value === 'string' && (STUDY_YEARS as readonly string[]).includes(value);
}

/** Years that save on the first tap; MD3 and MD4 continue to a rotation pick. */
export function yearNeedsRotation(year: StudyYear): boolean {
  return year === 'md3' || year === 'md4';
}

/**
 * The modules a year is enrolled in on its own. Empty for MD3 and MD4, whose
 * modules come from the rotation chosen (ROTATION_TO_MODULES).
 */
export function modulesForYear(year: StudyYear): string[] {
  switch (year) {
    case 'md1': return [...MD1_MODULES];
    case 'md2': return [...MD2_ACTIVE_MODULES];
    default: return [];
  }
}

/** The institution a year-only save records; null where the rotation route owns it. */
export function institutionForYear(year: StudyYear): string | null {
  switch (year) {
    case 'md1': return MD1_INSTITUTION;
    case 'md2': return MD2_INSTITUTION;
    default: return null;
  }
}

/** Institutions that belong to the USyd family, so a year choice may replace them. */
export const USYD_YEAR_INSTITUTIONS: ReadonlySet<string> = new Set(['usyd', MD1_INSTITUTION, MD2_INSTITUTION]);

/** Read the stored answer back from `User.feedProfile`; anything else is unset. */
export function readOnboardingYear(feedProfile: unknown): StudyYear | null {
  if (!feedProfile || typeof feedProfile !== 'object' || Array.isArray(feedProfile)) return null;
  const value = (feedProfile as Record<string, unknown>).onboardingYear;
  return isStudyYear(value) ? value : null;
}
