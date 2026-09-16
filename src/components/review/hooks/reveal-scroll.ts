/**
 * Visibility math for the post-answer auto-scroll.
 *
 * After the student answers, newly revealed content below the fold should be
 * brought into view without a manual scroll (the reference learner, 2026-07-09).
 * Two early bugs made that not happen:
 *
 *   1. it was gated on `matchMedia('(pointer: coarse)')`, so it only ever ran on
 *      touch devices — never on the desktop where most reviewing happens;
 *   2. the "is it already visible?" test used a symmetric 12px margin, ignoring
 *      the ~79px fixed grading/confidence footer. Content sitting *behind* the
 *      footer therefore counted as visible and no scroll was triggered. That
 *      same footer shows up as `bottomCoverPx: 79` on 76 of 88 user flags.
 *
 * A later over-correction scrolled the whole tall reveal (context + figure) into
 * view with `block: 'start'`, which yanked the student past the answer
 * (highlighted options / filled cloze) sitting ABOVE the reveal block — before
 * they'd read it (2026-08-04). The gate is now head-only, and the scroll is a
 * small peek above the footer rather than an align-to-top.
 */

/** Height of the fixed grading/confidence footer, plus a little breathing room.
 *  Measured at 79-85px across reported viewports (`bottomCoverPx` telemetry). */
export const FOOTER_SAFE_PX = 96;

export const TOP_SAFE_PX = 12;

/** How much of the reveal head to bring above the footer when peeking. Enough
 *  for the Correct/Incorrect chip + a line of context — not the whole figure. */
export const REVEAL_PEEK_PX = 120;

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
 * Whether post-answer auto-scroll should fire.
 *
 * Only when the START of the reveal (answer/explanation head) has not yet
 * entered the usable viewport. A tall context/figure trailing below the fold
 * is NOT a reason to scroll — the answer the student just revealed sits above
 * the reveal block, and yanking past it is the bug.
 */
export function needsRevealScroll(
  rect: Rect,
  viewportHeight: number,
  bottomMargin: number = FOOTER_SAFE_PX,
): boolean {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;
  return rect.top > viewportHeight - bottomMargin;
}

/**
 * Pixels to `window.scrollBy` so the reveal HEAD peeks above the footer.
 * Returns 0 when no scroll is needed. Never aligns the block to the top of
 * the viewport — that would hide the answer (options / filled cloze) above.
 */
export function revealScrollDelta(
  rect: Rect,
  viewportHeight: number,
  bottomMargin: number = FOOTER_SAFE_PX,
  peekPx: number = REVEAL_PEEK_PX,
): number {
  if (!needsRevealScroll(rect, viewportHeight, bottomMargin)) return 0;
  const targetTop = viewportHeight - bottomMargin - peekPx;
  return Math.max(0, rect.top - targetTop);
}

/**
 * Which `scrollIntoView` block alignment to use for a full-block scroll.
 *
 * Prefer `revealScrollDelta` for the post-answer path — it peeks instead of
 * aligning. This helper remains for callers that still use scrollIntoView:
 * `block: 'nearest'` on an over-tall element that extends below the fold
 * scrolls to bring its BOTTOM into view, which pushes the answer (at the very
 * top of the block) off the top of the screen. So: 'start' when it overflows,
 * 'nearest' when it fits.
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

/**
 * Peek-scroll the reveal head into view above the fixed footer.
 * No-ops when the head is already visible (even if a tall tail is not).
 */
export function peekRevealIntoView(
  el: { getBoundingClientRect: () => DOMRect } | null | undefined,
  behavior: ScrollBehavior,
): boolean {
  if (!el || typeof window === 'undefined') return false;
  const delta = revealScrollDelta(el.getBoundingClientRect(), window.innerHeight);
  if (delta <= 0) return false;
  window.scrollBy({ top: delta, behavior });
  return true;
}
