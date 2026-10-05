/** Shared MD3 review geometry; no private review-controller dependencies. */
export type ReviewPaneKind = 'prompt-card' | 'prompt-portrait-card' | 'prompt-question' | 'supplementary' | 'supplementary-wide';

const PANE_GRID: Record<ReviewPaneKind, string> = {
  // A prompt card's text is a one-line instruction plus a short provenance
  // note. 24rem/34% held about a third of a wide viewport for it, which read
  // as more empty column than text. Measured: on a landscape plate at
  // 2000x1300 this takes the figure from 1124 to 1220px. Known portrait
  // figures instead use the reading measure below.
  'prompt-card':
    'contents lg:grid lg:grid-cols-[minmax(0,min(18rem,26%))_minmax(0,1fr)] '
    + 'lg:grid-rows-[auto_1fr] lg:gap-x-7 lg:gap-y-0 lg:items-start',
  'prompt-portrait-card':
    'contents lg:grid lg:grid-cols-[minmax(0,min(28rem,44%))_minmax(0,1fr)] '
    + 'lg:grid-rows-[auto_1fr] lg:gap-x-7 lg:gap-y-0 lg:items-start',
  'prompt-question':
    'contents lg:grid lg:grid-cols-[minmax(0,min(34rem,45%))_minmax(0,1fr)] '
    + 'lg:grid-rows-[auto_1fr] lg:gap-x-7 lg:gap-y-0 lg:items-start',
  supplementary:
    'contents lg:grid lg:grid-cols-[minmax(0,min(42rem,55%))_minmax(0,1fr)] '
    + 'lg:grid-rows-[auto_1fr] lg:gap-x-7 lg:gap-y-0 lg:items-start',
  // Same split as a prompt question: the text keeps a readable measure and a
  // width-bound figure takes the surplus. At 1440 the figure goes from ~580
  // to ~700px; at 1180 from ~425 to ~530.
  'supplementary-wide':
    'contents lg:grid lg:grid-cols-[minmax(0,min(34rem,45%))_minmax(0,1fr)] '
    + 'lg:grid-rows-[auto_1fr] lg:gap-x-7 lg:gap-y-0 lg:items-start',
};

export function reviewPaneGridClass(kind: ReviewPaneKind): string {
  return PANE_GRID[kind];
}

/**
 * Column 1 is a reading MEASURE, not a fraction of whatever the shell is.
 *
 * It was `0.85fr`, which made the prose narrow as the shell widened — the
 * opposite of what reveal should do. Measured: at a 1440px viewport the column
 * went 672px before reveal to 575px after, and at 1180px (a laptop, the common
 * case) it fell to 450px, a thin column for explanation prose beside a
 * portrait figure.
 *
 * `min(42rem, 55%)` reads as: never wider than the 42rem measure the card uses
 * everywhere else, and never more than 55% of the shell so the figure keeps a
 * usable share when the window is narrow. At 1440 the prose is back to its
 * full 672 — the same width it had BEFORE reveal, so reveal no longer reflows
 * the text it only moves it — and the figure gets 580. At 1180 the prose is
 * 554 and the figure 425.
 */
export const REVIEW_PANE_GRID =
  'contents lg:grid lg:grid-cols-[minmax(0,min(42rem,55%))_minmax(0,1fr)] lg:grid-rows-[auto_1fr] '
  + 'lg:gap-x-7 lg:gap-y-0 lg:items-start';

/** Every cell is `display: contents` until `lg`, so below the breakpoint the
 *  three wrappers generate no boxes at all and the markup is not merely
 *  equivalent to today's flat list — it lays out as the identical box tree. An
 *  ordinary unstyled div would be close, but it also blocks margin collapsing
 *  across its boundary, which is the sort of one-pixel difference that only
 *  shows up in a visual diff weeks later. */
const PANE_CELL = 'contents lg:block';

/** Cell classes when the item has no figure: no grid, so no boxes either. */
export const REVIEW_PANE_CELL_FLAT = 'contents';

/** Column 1, row 1 — the stem (and, for a supplementary figure, the answer and
 *  explanation that precede the figure in the DOM). */
export const REVIEW_PANE_TEXT_TOP = `${PANE_CELL} min-w-0 lg:col-start-1 lg:row-start-1`;

/** Column 1, row 2 — whatever follows the figure in the DOM. This is the row
 *  the media pane's surplus height is absorbed into. */
export const REVIEW_PANE_TEXT_BOTTOM = `${PANE_CELL} min-w-0 lg:col-start-1 lg:row-start-2`;

/** Column 2, spanning both text rows. Sticky so a long explanation scrolls
 *  under a figure that stays put; `top` clears the 52px sticky review header
 *  (`UnifiedReview.tsx`), which the `lg:top-6` of the ClinicalLesson precedent
 *  would not — that surface has no sticky header. */
export const REVIEW_PANE_MEDIA =
  `${PANE_CELL} lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-[4.5rem]`;

const SHELL_WIDTH_PROMPT = 'max-w-2xl lg:max-w-[80rem] 2xl:max-w-[min(96rem,92vw)]';
const SHELL_WIDTH_PORTRAIT = 'max-w-2xl lg:max-w-[64rem] 2xl:max-w-[76rem]';
const SHELL_WIDTH_SUPPLEMENTARY = 'max-w-2xl lg:max-w-[80rem]';

export function reviewShellWidthClass(
  usesSidePane: boolean,
  kind: ReviewPaneKind = 'supplementary',
): string {
  if (!usesSidePane) return 'max-w-2xl';
  if (kind === 'prompt-portrait-card') return SHELL_WIDTH_PORTRAIT;
  return kind === 'supplementary' ? SHELL_WIDTH_SUPPLEMENTARY : SHELL_WIDTH_PROMPT;
}
