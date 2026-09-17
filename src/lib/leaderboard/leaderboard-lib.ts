/**
 * Leaderboard: the pure half.
 *
 * Opt-in only. A learner who joins picks a handle and is shown to other joined
 * learners; nobody who has not joined sees the board or appears on it. Ranked
 * by deliberate reviews in the last seven days — the same definition the daily
 * usage table uses (card and MCQ answers, skips excluded) — with an all-time
 * total and a current streak beside it. Accuracy is deliberately absent: it is
 * gameable by answering only easy cards, which is the opposite of what the
 * scheduler is trying to serve.
 *
 * The handle is the only thing shown. It is never derived from a name or an
 * email, and an email-shaped handle is refused so nobody can leak their own
 * address by accident.
 */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const LEADERBOARD_WINDOW_DAYS = 7;
export const LEADERBOARD_LIMIT = 20;

const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]*[A-Za-z0-9]$/;

export type HandleVerdict =
  | { ok: true; handle: string }
  | { ok: false; error: string };

/** Normalise and validate a proposed handle. */
export function validateHandle(raw: unknown): HandleVerdict {
  if (typeof raw !== 'string') return { ok: false, error: 'Pick a name for the board.' };
  const handle = raw.trim().replace(/\s+/g, ' ');
  if (handle.length < HANDLE_MIN) {
    return { ok: false, error: `Use at least ${HANDLE_MIN} characters.` };
  }
  if (handle.length > HANDLE_MAX) {
    return { ok: false, error: `Keep it to ${HANDLE_MAX} characters.` };
  }
  if (handle.includes('@') || /\.[a-z]{2,}$/i.test(handle.replace(/\s/g, ''))) {
    return { ok: false, error: 'That looks like an email address; pick a name instead.' };
  }
  if (!HANDLE_PATTERN.test(handle)) {
    return { ok: false, error: 'Letters, numbers, spaces, dots, dashes and underscores only.' };
  }
  return { ok: true, handle };
}

export interface LeaderboardInput {
  userId: string;
  handle: string;
  windowReviews: number;
  allTimeReviews: number;
  /** Distinct Australia/Sydney calendar days with at least one answer, ISO date strings. */
  activeDays: string[];
}

export interface LeaderboardRow {
  rank: number;
  handle: string;
  windowReviews: number;
  allTimeReviews: number;
  streakDays: number;
  isMe: boolean;
}

/**
 * Consecutive Sydney days with an answer, counted back from today. A learner
 * who has not answered today keeps yesterday's streak alive until midnight,
 * so "today or yesterday" is the anchor, then strictly consecutive days.
 */
export function currentStreak(activeDays: ReadonlySet<string>, todayIso: string): number {
  const start = activeDays.has(todayIso) ? todayIso : previousDay(todayIso);
  if (!activeDays.has(start)) return 0;
  let streak = 0;
  let day = start;
  while (activeDays.has(day)) {
    streak += 1;
    day = previousDay(day);
  }
  return streak;
}

function previousDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Rank: window reviews descending, then all-time descending, then handle,
 * so the order is stable and two equal learners are not shuffled between
 * loads. Ties share a rank number.
 */
export function rankLeaderboard(
  inputs: readonly LeaderboardInput[],
  viewerId: string,
  todayIso: string,
  limit = LEADERBOARD_LIMIT,
): { rows: LeaderboardRow[]; me: LeaderboardRow | null } {
  const sorted = [...inputs].sort((a, b) =>
    b.windowReviews - a.windowReviews
    || b.allTimeReviews - a.allTimeReviews
    || a.handle.localeCompare(b.handle),
  );
  const all: LeaderboardRow[] = [];
  let rank = 0;
  sorted.forEach((row, index) => {
    const prev = sorted[index - 1];
    if (!prev || prev.windowReviews !== row.windowReviews || prev.allTimeReviews !== row.allTimeReviews) {
      rank = index + 1;
    }
    all.push({
      rank,
      handle: row.handle,
      windowReviews: row.windowReviews,
      allTimeReviews: row.allTimeReviews,
      streakDays: currentStreak(new Set(row.activeDays), todayIso),
      isMe: row.userId === viewerId,
    });
  });
  const me = all.find((row) => row.isMe) ?? null;
  const rows = all.slice(0, limit);
  if (me && !rows.includes(me)) rows.push(me);
  return { rows, me };
}
