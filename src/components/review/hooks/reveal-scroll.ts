/**
 * Visibility math for the post-answer auto-scroll.
 *
 * After the student answers, the answer + context + figure should be brought
 * into view without a manual scroll (the reference learner, 2026-07-09). Two things made that not
 * happen:
 *
 *   1. it was gated on `matchMedia('(pointer: coarse)')`, so it only ever ran on
 *      touch devices — never on the desktop where most reviewing happens;
 *   2. the "is it already visible?" test used a symmetric 12px margin, ignoring
 *      the ~79px fixed grading/confidence footer. Content sitting *behind* the
 *      footer therefore counted as visible and no scroll was triggered. That
 *      same footer shows up as `bottomCoverPx: 79` on 76 of 88 user flags.
 */

/** Height of the fixed grading/confidence footer, plus a little breathing room.
 *  Measured at 79-85px across reported viewports (`bottomCoverPx` telemetry). */
export const FOOTER_SAFE_PX = 96;

export const TOP_SAFE_PX = 12;

export type Rect = { top: number; bottom: number };

/**
 * True when `rect` is not fully visible in the usable viewport — i.e. it runs
 * above the top edge, or below the top of the fixed footer.
 */
export function isRectObscured(
  rect: Rect,
  viewportHeight: number,
  topMargin: number = TOP_SAFE_PX,
  bottomMargin: number = FOOTER_SAFE_PX,
): boolean {
  return rect.top < topMargin || rect.bottom > viewportHeight - bottomMargin;
}

/**
 * Which `scrollIntoView` block alignment to use for the post-reveal scroll.
 *
 * The reveal block is not just the answer — it wraps answer + context + an
 * optional after-reveal figure + the crosslinks row, so it is regularly TALLER
 * than the usable viewport. `block: 'nearest'` on an over-tall element that
 * extends below the fold scrolls to bring its BOTTOM into view, which pushes
 * the answer (at the very top of the block) off the top of the screen — the
 * student then has to scroll back up to read the thing they just revealed
 * (the reference learner, 2026-07-31: "the autoscroll... it's forcing me to scroll up to see the
 * answer").
 *
 * When the block cannot fit, the answer is what must be on screen; the context
 * and figure are allowed to run below the fold. So: 'start' when it overflows,
 * 'nearest' (minimal movement) when it fits.
 */
export function revealScrollBlock(
  blockHeight: number,
  viewportHeight: number,
): ScrollLogicalPosition {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 'nearest';
  const usable = viewportHeight - FOOTER_SAFE_PX;
  return blockHeight > usable ? 'start' : 'nearest';
}

/** Minimal scroll target — an element (or ref.current) that may expose
 *  scrollIntoView. Typed loosely so a bare `{}` and jsdom (no scrollIntoView)
 *  are tolerated. */
type ScrollTarget = { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void } | null | undefined;

/**
 * Reset the review scroll position to the top of `el`, INSTANTLY.
 *
 * Called on card advance. It MUST be instant (`behavior: 'auto'`), never
 * 'smooth': advanceToNext() runs this synchronously and then swaps the card
 * via React state, and on mobile a *scheduled* smooth animation is superseded
 * by that reflow and never lands — leaving the next card scrolled partway down
 * (the reference learner, 2026-07-22: "next card I've gotta scroll up"). Aligning to `block:
 * 'start'` keeps the review header at the top even when content sits above the
 * review root. Optional-chained so jsdom (no scrollIntoView) tolerates it.
 */
export function resetScrollToTop(el: ScrollTarget): void {
  el?.scrollIntoView?.({ behavior: 'auto', block: 'start' });
}
