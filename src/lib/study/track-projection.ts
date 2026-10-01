export interface TrackProjectionInput {
  totalItems: number;
  seenItems: number;
  daysToExam: number | null;
  consolidationDays: number | null;
  /**
   * First-seen new-items-per-day, newest first (index 0 = today). Drives
   * coverage projection — "% of scope first-seen by exam".
   */
  recentFirstSeenHistory?: number[];
  /**
   * Total daily activity (every card/MCQ touched, including repeats),
   * newest first. Drives the "how many cards/day am I doing" status and
   * the daily-activity sparkline.
   */
  recentTotalHistory?: number[];
  /** Adaptive daily-work goal from computeDailyTarget. Null when unknown. */
  dailyTarget: number | null;
  /** New items first-seen today (partial day). */
  todayNewItems: number;
  /** Total items touched today (partial day). */
  todayTotalItems: number;
}

export interface TrackProjection {
  totalItems: number;
  seenItems: number;
  unseenItems: number;
  daysToExam: number | null;
  targetDay: number | null;
  /** % of scope covered right now. */
  currentPercent: number;
  /** Projected % covered by exam, given recent first-seen pace. */
  finalOverallPercent: number;
  /** True when recent first-seen pace will cover scope by consolidation. */
  onTrackOverall: boolean;
  /** Items short of full coverage at recent first-seen pace. */
  shortfallItems: number;
  /** Average new items first-seen per day over last 13 completed days. */
  recentNewPerDay: number;
  /** Average total items touched per day (new + reviews) over last 13 days. */
  recentTotalPerDay: number;
  /** Today's new items so far (partial). */
  todayNewItems: number;
  /** Today's total items so far (partial). */
  todayTotalItems: number;
  /**
   * Adaptive daily-work goal echoed back from the input. The component
   * uses this as the headline "target" so the user sees an achievable
   * total-cards/day number rather than a stripped-down new-items floor.
   */
  dailyTarget: number | null;
  /** 14-day total-activity series for the sparkline (newest-first). */
  dailyTotalItemsHistory: number[];
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentForItems(items: number, totalItems: number): number {
  if (totalItems <= 0) return 0;
  return roundTenth(clampPercent((items / totalItems) * 100));
}

function averageCompletedDays(history: number[] = []): number {
  // Index 0 is today (partial). Average over completed days only.
  const completedDays = history.slice(1);
  if (completedDays.length === 0) return 0;
  const total = completedDays.reduce((sum, value) => sum + Math.max(0, value), 0);
  return roundTenth(total / completedDays.length);
}

export function computeTrackProjection(input: TrackProjectionInput): TrackProjection {
  const totalItems = Math.max(0, input.totalItems);
  const seenItems = Math.min(totalItems, Math.max(0, input.seenItems));
  const unseenItems = Math.max(0, totalItems - seenItems);
  const todayNewItems = Math.max(0, input.todayNewItems);
  const todayTotalItems = Math.max(0, input.todayTotalItems);

  const recentNewPerDay = averageCompletedDays(input.recentFirstSeenHistory);
  const recentTotalPerDay = averageCompletedDays(input.recentTotalHistory);

  const dailyTotalItemsHistory = Array.isArray(input.recentTotalHistory)
    ? input.recentTotalHistory.map((n) => Math.max(0, Math.floor(n)))
    : [];

  const currentPercent = percentForItems(seenItems, totalItems);
  const dailyTarget = input.dailyTarget != null ? Math.max(0, Math.round(input.dailyTarget)) : null;

  if (input.daysToExam === null || input.daysToExam < 0) {
    return {
      totalItems,
      seenItems,
      unseenItems,
      daysToExam: null,
      targetDay: null,
      currentPercent,
      finalOverallPercent: currentPercent,
      onTrackOverall: false,
      shortfallItems: 0,
      recentNewPerDay,
      recentTotalPerDay,
      todayNewItems,
      todayTotalItems,
      dailyTarget,
      dailyTotalItemsHistory,
    };
  }

  const daysToExam = Math.max(0, Math.floor(input.daysToExam));
  const consolidationDays = Math.max(0, input.consolidationDays ?? 0);
  const targetDay = Math.max(daysToExam - consolidationDays, 1);

  // Coverage projection: how many NEW items will be first-seen by exam,
  // assuming the recent first-seen rate continues. This is the right metric
  // for the coverage bar — "% of scope you'll have first-laid-eyes-on".
  const finalOverallItems = seenItems + recentNewPerDay * targetDay;
  const finalOverallPercent = percentForItems(finalOverallItems, totalItems);
  const shortfallItems = roundTenth(Math.max(0, totalItems - finalOverallItems));

  return {
    totalItems,
    seenItems,
    unseenItems,
    daysToExam,
    targetDay,
    currentPercent,
    finalOverallPercent,
    onTrackOverall: finalOverallItems >= totalItems && totalItems > 0,
    shortfallItems,
    recentNewPerDay,
    recentTotalPerDay,
    todayNewItems,
    todayTotalItems,
    dailyTarget,
    dailyTotalItemsHistory,
  };
}
