/**
 * Spaced repetition for figures, not just a daily mute.
 *
 * This arrived as three successive refinements of one report, and each moved
 * the control to a better place. The first was that a figure was reappearing
 * often enough to stop carrying information. The obvious answer — cap how many
 * cards may share a figure — is only a proxy, because three cards sharing one
 * figure can all fall due the same morning. A fixed daily cooldown fixes that
 * but still shows the same picture every single day forever. What actually
 * matters is the INTERVAL between showings, and it should expand with
 * familiarity, exactly as the scheduler already does for card content.
 *
 * The measurement that settled it: over 60 days of delivered card serves,
 * repeats within a session were negligible (7 of 1,909 showings, worst 2x),
 * but within a day 30 figures were shown 3-4 times and 9 were shown 5-8 times.
 * So the control belongs at serve time, where real exposure is known, and not
 * at authoring time where card-count is only a stand-in for it.
 *
 * The window therefore grows geometrically with the number of times a figure
 * has been shown: roughly a day, then three, then nine, then a month,
 * ceilinged so a figure is spaced out rather than retired. Within the window
 * the penalty ramps down smoothly, so a figure becomes gradually more servable
 * rather than snapping back at an arbitrary boundary.
 *
 * Capped, never excluded: a figure that genuinely illustrates its card must
 * stay reachable when that card is the right thing to serve, and a hard filter
 * would break image-prompt cards outright, where the figure IS the question.
 */

/** Interval before the first repeat of a figure. */
export const FIGURE_BASE_COOLDOWN_HOURS = 24;

/** Each further showing multiplies the interval: 1d → 3d → 9d → 27d … */
export const FIGURE_SPACING_FACTOR = 3;

/** Ceiling on the interval (60 days), so a figure is spaced out, not retired. */
export const FIGURE_MAX_COOLDOWN_HOURS = 24 * 60;

/** One step of "seen too recently", sized like PACING_AHEAD_PENALTY so figure
 *  fatigue trades off sensibly against curriculum pacing. */
export const FIGURE_REPEAT_STEP = 3;

/** At most this many steps — a strong nudge, never a ban. */
export const FIGURE_MAX_STEPS = 3;

export interface FigureExposure {
  /** How many times this figure has been shown to this user. */
  count: number;
  /** When it was last shown. */
  mostRecentMs: number;
}

/**
 * The interval this figure has earned, given how often it has been seen.
 *
 * Exposed separately so the audit can report the schedule a figure is on
 * without re-deriving the curve.
 */
export function figureCooldownHours(count: number): number {
  if (count <= 0) return 0;
  const grown = FIGURE_BASE_COOLDOWN_HOURS * FIGURE_SPACING_FACTOR ** (count - 1);
  return Math.min(grown, FIGURE_MAX_COOLDOWN_HOURS);
}

/**
 * Positive sinks, zero is neutral — the same axis as the other rank boosts.
 *
 * A card with no figure, or one whose interval has elapsed, returns 0 and keeps
 * exactly the position the rest of the ranker gave it.
 */
export function figureCooldownBoost(
  imageUrl: string | null | undefined,
  recentFigureExposures: ReadonlyMap<string, FigureExposure> | null | undefined,
  nowMs: number,
): number {
  if (!imageUrl || !recentFigureExposures || recentFigureExposures.size === 0) return 0;
  const exposure = recentFigureExposures.get(imageUrl);
  if (!exposure || exposure.count <= 0) return 0;

  const elapsedHours = (nowMs - exposure.mostRecentMs) / (60 * 60 * 1000);
  if (elapsedHours < 0) return 0;

  const window = figureCooldownHours(exposure.count);
  if (elapsedHours >= window) return 0;

  const remaining = 1 - elapsedHours / window;
  return FIGURE_REPEAT_STEP * FIGURE_MAX_STEPS * remaining;
}
