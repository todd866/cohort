import type { ImageRevealRegion } from './types';

/** Share of the image width the focus window shows by default. At ~1100 px wide
 *  a flowchart's text is ~11 px; a third of that width across a phone, or
 *  across the desktop side pane beside the whole-chart overview, draws it at
 *  about printed size while keeping the neighbouring boxes in view. */
const WINDOW_WIDTH = 0.32;
/** Width over height of the window in pixels: a landscape frame fills a phone
 *  column without pushing the question off screen. */
const WINDOW_ASPECT = 1.35;
/** Room kept around the hidden box, as a share of the image. */
const MARGIN = 0.06;

/**
 * The zoomed window a hide-one diagram card shows around its hidden box,
 * normalised to the image like `revealRegions`. The whole diagram is shown
 * alongside it as an overview, so the window only needs the box and its
 * neighbours.
 */
export function regionFocusCrop(
  regions: readonly ImageRevealRegion[] | undefined,
  imageWidth: number,
  imageHeight: number,
): ImageRevealRegion | undefined {
  if (!regions?.length || !(imageWidth > 0) || !(imageHeight > 0)) return undefined;
  const x0 = Math.min(...regions.map((r) => r.x));
  const y0 = Math.min(...regions.map((r) => r.y));
  const x1 = Math.max(...regions.map((r) => r.x + r.width));
  const y1 = Math.max(...regions.map((r) => r.y + r.height));

  const width = Math.min(1, Math.max(WINDOW_WIDTH, x1 - x0 + 2 * MARGIN));
  const pixelAspect = imageWidth / imageHeight;
  const height = Math.min(1, Math.max(width * pixelAspect / WINDOW_ASPECT, y1 - y0 + 2 * MARGIN));

  const clamp = (start: number, size: number) => Math.min(Math.max(start, 0), 1 - size);
  return {
    x: clamp((x0 + x1) / 2 - width / 2, width),
    y: clamp((y0 + y1) / 2 - height / 2, height),
    width,
    height,
  };
}
