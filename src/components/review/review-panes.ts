import type { ReviewItem } from './hooks/types';
import { reviewImageIsPrompt } from './image-role';
import { clipIsPrompt } from './clip-role';
import { hasMarkdownTable, normalizeInlineTables } from '@/lib/inline-markdown';

/**
 * The side-pane layout contract for figured review items.
 *
 * Reported 2026-09-08: "I've got heaps of white space either side of the card
 * but I've gotta scroll for image + text". The shell was pinned to `max-w-2xl`
 * (672px) whether or not the item carried a figure, so on a wide window ~380px
 * sat idle each side while the stem, the context and the figure stacked past
 * the fold. On a surface graded hundreds of times a day, that is a scroll per
 * figured card.
 *
 * At `lg` and up a PROMPT figure lays out beside the question, so both are on
 * screen at once. A supplementary figure joins it at reveal: reserving a
 * column before reveal would leave half the card empty, but once the answer
 * is up the figure belongs beside it rather than below the fold.
 *
 * That last part reverses the original rule, which kept supplementary figures
 * centered throughout because opening a column on reveal moves and rewraps
 * the question the learner just read. That cost is real and was accepted on
 * owner instruction (2026-09-11): a scroll on every figured card was worse
 * than one reflow at the moment Space is pressed.
 * Everything below `lg` is untouched:
 * the grid utilities are all `lg:`-prefixed, so a phone gets exactly the
 * stacked layout it has today, down to the DOM order.
 *
 * ## Why three cells and not two
 *
 * The figure is rendered by exactly ONE mounted `<CardImage>`. A
 * `hidden lg:block` / `lg:hidden` pair would be far simpler and is disqualified
 * three times over: `useImageTracking` dedupes impressions per hook instance
 * (so a duplicate mount double-counts `image_impression` / `image_reveal` and
 * silently halves every figure's flagRate in `npm run audit:images`),
 * `CardImage`'s offline resolver mints a fresh object URL and a fresh signed
 * `/api/figures/delivery` mint per instance, and `SensitiveMediaGate` registers
 * a window keydown listener in the CAPTURE phase that calls
 * `stopImmediatePropagation()` on Space — two gates means the first Space
 * unblurs one copy, the second unblurs the other, and only the third reveals.
 *
 * So the single figure keeps its real DOM position and CSS moves it. Grid
 * placement is visual only — assistive tech and Tab follow the DOM — which is
 * the other half of the reason the split point moves:
 *
 *  - a PROMPT figure splits after the stem, so a screen reader still hears
 *    stem → figure → options rather than hearing the figure after the answer;
 *  - a SUPPLEMENTARY (after-reveal) figure stays between the explanation and
 *    "Learn more →", with all wrappers flattened.
 *
 * For a prompt figure the media pane spans both text rows in column 2.
 */

/** Grid container. `items-start` is load-bearing twice: it stops the media pane
 *  stretching to the row height (which would leave `position: sticky` no room
 *  to travel), and it keeps the stem pinned to the top of row 1 so the reveal
 *  cannot nudge it. Row gap is zero because every cell already carries its own
 *  margins — a row gap would also open a dead band under a pre-reveal card,
 *  where row 2 is still empty.
 *
 *  `grid-rows-[auto_1fr]` is what keeps the text honest. A media pane spanning
 *  two `auto` rows distributes its height across BOTH of them, which floated
 *  the links row into the middle of an empty column instead of sitting under
 *  the explanation. A flexible second row absorbs the media's excess instead,
 *  so row 1 stays exactly as tall as its own text.
 *
 *  The container is `contents` below `lg` for the same reason the cells are:
 *  with the container and all three cells generating no boxes, a phone renders
 *  the identical box tree to the flat list this replaced, not merely an
 *  equivalent-looking one. */
/**
 * A question whose stem carries a results table — an LP panel, a DKA
 * progress panel. The table is question content in exactly the way a prompt
 * figure is: the learner reads the stem against it, so it earns the side pane
 * and the stem and options keep the reading column beside it. Asked for
 * twice on 2026-09-15: "the table of results lives on the right hand side and
 * the question on the left hand side references it".
 */
export function stemHasResultsTable(
  item: Pick<ReviewItem, 'type' | 'stem'> | null | undefined,
): boolean {
  if (!item || item.type !== 'question' || !item.stem) return false;
  return hasMarkdownTable(normalizeInlineTables(item.stem.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')));
}

export type ReviewPaneKind = 'prompt-card' | 'prompt-portrait-card' | 'prompt-question' | 'supplementary' | 'supplementary-wide';

/**
 * Which text column a pane should get, decided by what the text actually holds.
 *
 * A landscape PROMPT CARD often carries a short instruction, such as BlueLink's
 * "Name the highlighted structure." Its wide figure benefits from extra width.
 * A known PORTRAIT CARD is instead height-bound; a wider text measure and
 * tighter shell bring its explanation and picture together.
 *
 * A PROMPT QUESTION's text carries the stem and its options, so it needs real
 * width even though the figure is still the subject.
 *
 * SUPPLEMENTARY means the text is the answer prose. That is the reading
 * column, and it keeps the full measure.
 */
export function reviewPaneKind(
  item:
    | Pick<ReviewItem, 'type' | 'imageUrl' | 'imageKey' | 'imageRole' | 'imageMeta' | 'clip' | 'clipRole' | 'stem'>
    | null
    | undefined,
): ReviewPaneKind {
  if (!item) return 'supplementary';
  // A results table beside the stem needs the same column split as a prompt
  // figure on a question: the text side holds stem and options.
  if (stemHasResultsTable(item)) return 'prompt-question';
  const promptClip = clipIsPrompt(item.clipRole, item.clip);
  const prompt = promptClip
    || (Boolean(item.imageUrl || item.imageKey)
      && reviewImageIsPrompt(item.imageRole, item.imageMeta));
  if (!prompt) {
    // A WIDE supplementary figure — a two-panel radiograph-and-MRI composite
    // at 2:1 — is bounded by the pane's width, and beside the full reading
    // measure each panel came out a few hundred pixels across ("images should
    // be bigger", 2026-09-15). Known-landscape figures take the prompt-question
    // split instead: the prose keeps a real measure and the figure gains the
    // difference. Decided from metadata so reveal cannot change the grid.
    if (isWideFigure(item.imageMeta)) return 'supplementary-wide';
    return 'supplementary';
  }
  if (item.type === 'question') return 'prompt-question';
  // Portrait images stop growing at the height budget. Extra horizontal space
  // should join the prose and figure, not become a blank strip between them.
  // Resolve this from metadata before paint so reveal cannot change the grid.
  const width = item.imageMeta?.imageWidth;
  const height = item.imageMeta?.imageHeight;
  if (!promptClip && typeof width === 'number' && typeof height === 'number'
    && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    && width / height < 0.95) return 'prompt-portrait-card';
  return 'prompt-card';
}

/**
 * One full literal class string per kind. These are NOT built by interpolation:
 * Tailwind discovers classes by scanning source text, so a template-assembled
 * arbitrary value is invisible to it and emits no CSS at all — the grid then
 * silently falls back to a single column. Verified by building and grepping the
 * output for every template.
 *
 * Column 2 always takes the surplus; only the text measure differs.
 */
/** Width over height at or above which a supplementary figure is width-bound
 *  enough to deserve a wider pane. 1.5 is a landscape photograph; the two-panel
 *  composites that prompted this sit around 2. */
export const WIDE_FIGURE_RATIO = 1.5;

export function isWideFigure(meta: ReviewItem['imageMeta'] | null | undefined): boolean {
  const width = meta?.imageWidth;
  const height = meta?.imageHeight;
  return typeof width === 'number' && typeof height === 'number'
    && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    && width / height >= WIDE_FIGURE_RATIO;
}

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

/**
 * Prompt figures and prompt clips widen the shell unconditionally — they are
 * question content and must share the screen with the stem. A supplementary
 * figure widens it at reveal.
 *
 * That reveal-time reflow was previously ruled out, on the grounds that the
 * reading measure should not move mid-sentence. Reversed 2026-09-11 on owner
 * instruction: stacking put the figure below the explanation, so every figured
 * card cost a scroll to reach the thing the card was teaching. A one-off
 * reflow at the moment Space is pressed beats scrolling on every card. The
 * media pane is `lg:sticky`, so a long explanation then scrolls under a figure
 * that stays put.
 *
 * Text-only items keep the centered 42rem measure throughout, and a hidden
 * supplementary figure still reserves nothing — there is no empty column
 * before reveal (pinned by the e2e spec). Resolve this from the source
 * role/metadata synchronously, using the same predicate in the shell and item
 * views: no delayed measurement or duplicate image mount is needed.
 */
export function itemUsesSidePane(
  item:
    | Pick<ReviewItem, 'type' | 'imageUrl' | 'imageKey' | 'imageRole' | 'imageMeta' | 'clip' | 'clipRole' | 'stem'>
    | null
    | undefined,
  /**
   * Whether the answer is on screen. A supplementary figure does not exist for
   * the learner until then, so it earns the pane only once revealed.
   */
  revealed = false,
): boolean {
  if (!item) return false;
  if (item.type !== 'card' && item.type !== 'question') return false;
  // A prompt clip earns the side pane for exactly the reason a prompt figure
  // does: it is question content, so it and the stem have to be on screen at
  // the same time. A 16:9 clip is if anything worse stacked than a figure —
  // it is wider, so it pushes the cloze further below the fold.
  if (clipIsPrompt(item.clipRole, item.clip)) return true;
  // A results table in the stem is prompt content: see stemHasResultsTable.
  if (stemHasResultsTable(item)) return true;
  const hasFigure = Boolean(item.imageUrl || item.imageKey);
  if (!hasFigure) return false;
  if (reviewImageIsPrompt(item.imageRole, item.imageMeta)) return true;
  // Supplementary figure: centered while hidden, side-by-side once shown.
  return revealed;
}

/**
 * Shell width classes for the review card.
 *
 * `80rem` rather than `max-w-6xl` (72rem): at a 1440px window the available box
 * is 1312px, so 72rem binds and the figure pane comes out at ~599px — narrower
 * than the 629px a stacked figure has today. 80rem yields ~693px, which makes
 * the wide-monitor case a strict win instead of a trade. Below ~1330px neither
 * binds, so the 1180px window the complaint came from is unaffected.
 */
/**
 * Literal strings, not assembled — see PANE_GRID above for why Tailwind cannot
 * see an interpolated arbitrary value.
 *
 * A PROMPT pane may exceed 80rem on a very wide window. The corpus is split and
 * the two halves want different things: BlueLink's 4,747 anatomy plates are
 * uniformly 4:3 LANDSCAPE (measured 1175x881), so they are width-bound — at
 * 868px of column the figure is only 653px tall against a height budget of
 * ~896, and every extra pixel of width becomes a bigger figure. The 17,156
 * surgical-sciences plates are portrait (median 0.80) and height-bound.
 * Known portrait prompt cards now get a tighter centered shell: surplus width
 * otherwise creates a gap between their height-limited image and narrow text.
 *
 * SUPPLEMENTARY stays at 80rem. That column is answer prose, and its
 * min(42rem,55%) measure was tuned against this cap.
 *
 * The step is `2xl` (1536px) rather than `xl` (1280px) deliberately: at a 1280
 * viewport min(96rem,92vw) evaluates to 1177, NARROWER than the 80rem it would
 * replace, so an xl step would shrink the very layout it means to widen. At
 * 1536 it is 1413, and at 1800+ it is the full 96rem.
 */
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
