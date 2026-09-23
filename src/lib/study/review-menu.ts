import { orderFocusOptions } from '@/lib/study/focus-option-order';
import { ROTATION_LABELS } from '@/lib/rotation-labels';
import { USMLE_STEP1_OPEN_ROTATION } from '@/lib/usmle/raw-question-boundary';

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
}): string[] {
  const allowed = new Set(args.authorized.filter((slug) => slug !== 'usmle-step1'));
  const pin = args.calendarRotation;
  const wanted = args.saved === null ? DEFAULT_REVIEW_MENU_SUBJECTS : args.saved;
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
