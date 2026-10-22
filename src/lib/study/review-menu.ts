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
] as const;

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
  return orderFocusOptions(chosen);
}
