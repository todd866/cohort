/**
 * Does a clip actually move?
 *
 * A clip is served as the card's stem on the promise that something in it
 * happens — a pointer traces a rootlet, an instrument opens a plane. Two
 * "anatomy-motion" clips cut from a lecture turned out to be a still
 * photograph with a highlight fading in. They played perfectly and a learner
 * flagged one as "video isn't playing", which from the chair is the same
 * thing: nothing moved, so there was nothing to watch.
 *
 * The measurement is ffmpeg's `tblend=all_mode=difference` followed by
 * `signalstats`: each frame becomes the absolute luma difference from the frame
 * before it, and `YAVG` is that difference averaged over the frame. Averaging
 * again over the clip gives one number. On the ten clips in production the two
 * stills scored 0.01 and 0.24; the quietest real operative window (a
 * seromuscular incision being spread) scored 2.23 and the rest 3.4–13.1. The
 * floor sits well inside that gap.
 *
 * The cutter (`scripts/video/cut-clip.ts`) refuses a static clip. This module
 * holds only the pure parts so the decision can be tested without ffmpeg.
 */

export const STATIC_CLIP_FLOOR = 1.0;

/** The ffmpeg filter chain whose `metadata=print` output `parseFrameDifferences` reads. */
export const FRAME_DIFFERENCE_FILTER =
  'tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-';

const YAVG_LINE = /^lavfi\.signalstats\.YAVG=([0-9.]+)\s*$/;

/** One value per frame, in order, from the `metadata=print` lines. */
export function parseFrameDifferences(ffmpegOutput: string): number[] {
  const out: number[] = [];
  for (const line of ffmpegOutput.split('\n')) {
    const m = YAVG_LINE.exec(line.trim());
    if (!m) continue;
    const value = Number(m[1]);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

export function meanFrameDifference(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Fails closed: a clip whose motion could not be measured is treated as
 * static, because the cost of a silent still in the prompt slot is a learner
 * who cannot answer, and the cost of a false refusal is one re-cut.
 */
export function isStaticClip(mean: number | null): boolean {
  return mean === null || mean < STATIC_CLIP_FLOOR;
}
