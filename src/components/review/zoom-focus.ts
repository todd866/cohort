import type { ImageRevealRegion } from '@/lib/images/types';

/**
 * The point on the plate the learner actually clicked, as a normalised region.
 *
 * The magnifier used to anchor on the question's own reveal region, which is
 * right when the learner opens it to see what the question points at. It is
 * wrong when they click a particular structure: on a labelled anatomy plate
 * every corner is somebody's callout, so anchoring anywhere other than the
 * click throws away the only unambiguous statement of intent the learner made.
 *
 * Returned as a zero-size `ImageRevealRegion` so it feeds the existing
 * `anchorScroll` unchanged — a point is a box with no width.
 */
export function clickFocusRegion(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): ImageRevealRegion | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
    width: 0,
    height: 0,
  };
}
