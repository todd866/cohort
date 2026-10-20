/**
 * Daily goals: several targets a day, each a forecast band.
 *
 * Owner direction, 16 October 2026: "a red/yellow/green/dark-green review
 * system… the point is to have multiple goals per day… just make it
 * reasonable. Then we compare to the actual results."
 *
 * The day's adaptive target is the only number a learner sees. The colour
 * moves with progress toward it (owner, 17 Oct 2026): red below a third,
 * yellow to two thirds, green until the target, dark green at or past it.
 * These cut-offs are a starting point, not a calibration: audit:daily-goals
 * compares each learner's days with their actual exam band so they can be
 * retuned against results.
 *
 * Exam bands use the rotation's real KAT cohort mean (CC 76, PAAM 71; CAH and
 * PWH not published, 74 assumed): red more than 15 points below the mean,
 * yellow 5-15 below, green within 5 below, dark green 5 or more above.
 */

export type GoalBand = 'red' | 'yellow' | 'green' | 'dark-green';

export interface DailyGoals {
  /** The day's target: the one number shown, and where dark green begins. */
  target: number;
  yellow: number;
  green: number;
  darkGreen: number;
}

const YELLOW_FRACTION = 1 / 3;
const GREEN_FRACTION = 2 / 3;

export function dailyGoals(target: number | null | undefined): DailyGoals | null {
  if (target == null || !Number.isFinite(target) || target <= 0) return null;
  const darkGreen = Math.max(1, Math.round(target));
  const green = Math.min(darkGreen, Math.round(darkGreen * GREEN_FRACTION));
  const yellow = Math.min(green, Math.round(darkGreen * YELLOW_FRACTION));
  return { target: darkGreen, yellow, green, darkGreen };
}

export function dailyBand(reviewed: number, goals: DailyGoals): GoalBand {
  if (reviewed >= goals.darkGreen) return 'dark-green';
  if (reviewed >= goals.green) return 'green';
  if (reviewed >= goals.yellow) return 'yellow';
  return 'red';
}

/** The next goal above today's count, or null once dark green is reached. */
export function nextGoal(reviewed: number, goals: DailyGoals): number | null {
  if (reviewed < goals.yellow) return goals.yellow;
  if (reviewed < goals.green) return goals.green;
  if (reviewed < goals.darkGreen) return goals.darkGreen;
  return null;
}

/*
 * No glyph per band: colour carries it. Learners read a red cross as "you got
 * that wrong" and found the triangle baffling; the owner chose colour alone and
 * accessibility on request (17 Oct 2026).
 */

export const BAND_LABEL: Record<GoalBand, string> = {
  red: 'under a third of the target',
  yellow: 'past a third of the target',
  green: 'nearing the target',
  'dark-green': 'target reached',
};

const COHORT_MEAN: Record<string, number> = {
  'critical-care': 76,
  paam: 71,
};
const FALLBACK_COHORT_MEAN = 74;

export function examBand(score: number, rotation: string): GoalBand {
  const delta = score - (COHORT_MEAN[rotation] ?? FALLBACK_COHORT_MEAN);
  if (delta >= 5) return 'dark-green';
  if (delta >= -5) return 'green';
  if (delta >= -15) return 'yellow';
  return 'red';
}

/**
 * What a session end records so audit:daily-goals can band each study day
 * later. The daily target is otherwise held only in memory, so without this
 * no day could ever be compared with an exam result.
 */
export function dailyGoalMetadata(
  reviewedToday: number,
  target: number | null,
): { dailyTarget?: number; dailyGoals?: DailyGoals; dailyBand?: GoalBand } {
  const goals = dailyGoals(target);
  if (!goals) return {};
  return { dailyTarget: goals.target, dailyGoals: goals, dailyBand: dailyBand(reviewedToday, goals) };
}

/**
 * "130/264" until the day's target is reached, then just the count. The target
 * is the only number a learner is given: yellow and dark green are colour
 * changes, not published goals (owner, 17 Oct 2026: "make green = the number,
 * whereas dark green swap happens at an unspecified number"). Null without a target.
 */
export function goalProgressText(
  reviewed: number,
  target: number | null,
  format: (n: number) => string = String,
): { band: GoalBand; text: string } | null {
  const goals = dailyGoals(target);
  if (!goals) return null;
  const text = reviewed < goals.target ? `${format(reviewed)}/${format(goals.target)}` : format(reviewed);
  return { band: dailyBand(reviewed, goals), text };
}
