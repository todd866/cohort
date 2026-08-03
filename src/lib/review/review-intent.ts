export const REVIEW_FILTERS = ['at-risk', 'due', 'new'] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

export interface ReviewIntent {
  rotation?: string;
  week?: number;
  filter?: ReviewFilter;
}

interface SearchParamReader {
  get(name: string): string | null;
}

const REVIEW_FILTER_SET = new Set<string>(REVIEW_FILTERS);
const MIN_WEEK = 1;
const MAX_WEEK = 52;

/**
 * Parse the homepage's public review-link contract.
 *
 * Rotation values are entitlement-sensitive, so callers provide the rotations
 * the current user can actually select. Invalid or inactive values disappear
 * instead of widening the user's serving scope.
 */
export function parseReviewIntent(
  searchParams: SearchParamReader,
  selectableRotations: readonly string[],
): ReviewIntent {
  const intent: ReviewIntent = {};

  const rotation = searchParams.get('rotation');
  if (rotation) {
    // A supplied rotation owns the rest of the deep-link scope. If it is no
    // longer selectable (unenrolled, inactive, or malformed), discard the
    // complete intent instead of applying its week/filter to the normal
    // multi-rotation schedule.
    if (!selectableRotations.includes(rotation)) return intent;
    intent.rotation = rotation;
  }

  const rawWeek = searchParams.get('week');
  if (intent.rotation && rawWeek && /^\d+$/.test(rawWeek)) {
    const week = Number(rawWeek);
    if (week >= MIN_WEEK && week <= MAX_WEEK) intent.week = week;
  }

  const filter = searchParams.get('filter');
  if (filter && REVIEW_FILTER_SET.has(filter)) {
    intent.filter = filter as ReviewFilter;
  }

  return intent;
}

/** Build every review CTA against the same canonical root-query contract. */
export function buildReviewHref(intent: ReviewIntent): string {
  const params = new URLSearchParams();
  if (intent.rotation) params.set('rotation', intent.rotation);
  if (intent.week !== undefined) params.set('week', String(intent.week));
  if (intent.filter) params.set('filter', intent.filter);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}
