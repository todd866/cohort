import { orderFocusOptions } from '@/lib/study/focus-option-order';
import { ROTATION_LABELS } from '@/lib/rotation-labels';
import { USMLE_STEP1_OPEN_ROTATION } from '@/lib/usmle/raw-question-boundary';
import { MD1_DECK, MD1_REVIEW_MENU_SUBJECTS } from '@/lib/md1-program';

/**
 * Subject decks in the review menu before a learner customises it.
 * The booked block is added separately. Step 1 is the public bank.
 */
export const DEFAULT_REVIEW_MENU_SUBJECTS = [
  USMLE_STEP1_OPEN_ROTATION,
  'anking',
  'malleus',
  'toc',
  'bpt',
  'physical-exam',
  'anatomy',
  'surgical-sciences',
  'paediatric-surgery',
  'ortho',
  'derm',
  'neurosurg',
  'radiology',
  'neuroradiology',
  'obgyn',
] as const;

/**
 * Every deck the two default menus offered on 5 Nov 2026, when md3 began
 * recording which default decks a learner had been offered (BACKLOG 0t).
 * A menu saved before then stored only its ticks, so it is read as having
 * known exactly these. Never edit: add new default decks to the lists above,
 * and they reach every saved menu that has not seen them.
 */
export const REVIEW_MENU_DEFAULTS_KNOWN_BEFORE_TRACKING: readonly string[] = Object.freeze([
  USMLE_STEP1_OPEN_ROTATION, 'anking', 'malleus', 'toc', 'bpt', 'physical-exam', 'anatomy',
  'surgical-sciences', 'paediatric-surgery', 'ortho', 'derm', 'neurosurg', 'radiology',
  'neuroradiology', 'obgyn',
]);

/** The default decks a saved menu records as offered, written on each save. */
export function reviewMenuDefaultDecks(): string[] {
  return [...new Set<string>([...DEFAULT_REVIEW_MENU_SUBJECTS, ...MD1_REVIEW_MENU_SUBJECTS])];
}

/** The only Step 1 study rotation. */
export const STEP1_ROTATION = USMLE_STEP1_OPEN_ROTATION;

export function isReviewMenuSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROTATION_LABELS, slug);
}

export interface ReviewMenuChoice {
  slug: string;
  label: string;
  pinned: boolean;
  checked: boolean;
}

/**
 * Rotations offered in the review focus menu.
 *
 * `saved === null` is the shared default: the booked block plus the main
 * subject decks, including the one Step 1 bank. An array replaces that
 * default. The booked block stays listed either way. A slug the viewer may
 * not open is omitted. The retired private Step 1 slug never appears.
 */
export function reviewMenuRotations(args: {
  authorized: readonly string[];
  calendarRotation: string | null;
  saved: readonly string[] | null;
  /**
   * 'md1': a first-year learner. Their deck stands in for the booked block,
   * pinned only when the deck registry authorizes it, and their default is the
   * first-year subject list rather than the Year 3 one.
   */
  program?: 'md1' | null;
  /**
   * Default decks the learner had been offered when they saved (User.reviewMenuKnownDecks).
   * Empty means a menu saved before that was recorded. A default deck missing
   * from it is new to them and is added; one they saw and unticked stays off.
   */
  known?: readonly string[] | null;
  /** The current default decks; tests override it. */
  defaults?: readonly string[];
}): string[] {
  const allowed = new Set(args.authorized.filter((slug) => slug !== 'usmle-step1'));
  const md1 = args.program === 'md1';
  const pin = md1
    ? (allowed.has(MD1_DECK) ? MD1_DECK : null)
    : args.calendarRotation;
  const defaults = md1 ? MD1_REVIEW_MENU_SUBJECTS : DEFAULT_REVIEW_MENU_SUBJECTS;
  const wanted = args.saved === null ? defaults : args.saved;
  const chosen: string[] = [];
  const seen = new Set<string>();
  const add = (slug: string | null | undefined, force: boolean) => {
    if (!slug || slug === 'usmle-step1' || seen.has(slug)) return;
    if (!force && !allowed.has(slug)) return;
    seen.add(slug);
    chosen.push(slug);
  };
  add(pin, true);
  for (const slug of wanted) add(slug, false);
  if (args.saved !== null && args.known != null) {
    const known = new Set(args.known.length > 0 ? args.known : REVIEW_MENU_DEFAULTS_KNOWN_BEFORE_TRACKING);
    for (const slug of args.defaults ?? defaults) if (!known.has(slug)) add(slug, false);
  }
  return orderFocusOptions(chosen);
}
