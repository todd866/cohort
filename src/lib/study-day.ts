import { startOfLocalDay } from '@/lib/analytics/local-day';
import { COURSE_TIME_ZONE, courseCalendarDay } from '@/lib/rotation-context';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Midnight on the course calendar: the start of the day that review counts,
 * daily view caps and fail floors are measured in.
 *
 * The server process runs in UTC, so `setHours(0, 0, 0, 0)` there is UTC
 * midnight, which is mid-morning on the course wall clock: "today" rolled over
 * during the morning's study. No per-learner timezone is stored on the grade
 * path, so the course timezone stands for every learner; one studying far from
 * it gets the course's midnight, not their own.
 *
 * `startOfLocalDay` steps back by the wall-clock time elapsed, which is an
 * hour out on the two days daylight saving changes. The correction below
 * re-reads the wall clock at the answer and closes that hour, so the whole
 * day shares one boundary.
 */
export function getCourseDayStart(
  now: Date = new Date(),
  timeZone: string = COURSE_TIME_ZONE,
): Date {
  const guess = startOfLocalDay(now, timeZone);
  const intoDayMs = guess.getTime() - startOfLocalDay(guess, timeZone).getTime();
  if (intoDayMs === 0) return guess;
  return new Date(
    intoDayMs < 12 * HOUR_MS
      ? guess.getTime() - intoDayMs
      : guess.getTime() + (24 * HOUR_MS - intoDayMs),
  );
}

/** The course-calendar midnight after the one given: 23, 24 or 25 hours on. */
export function getNextCourseDayStart(
  dayStart: Date,
  timeZone: string = COURSE_TIME_ZONE,
): Date {
  return getCourseDayStart(new Date(dayStart.getTime() + 36 * HOUR_MS), timeZone);
}

/** The course day boundary at `now`, as whole minutes east of UTC. */
export function courseDayOffsetMinutes(
  now: Date = new Date(),
  timeZone: string = COURSE_TIME_ZONE,
): number {
  const calendarDayUtc = courseCalendarDay(now, timeZone).getTime();
  return Math.round((calendarDayUtc - getCourseDayStart(now, timeZone).getTime()) / 60_000);
}

/**
 * Compute the start of the current "study day" — resets at a configurable
 * hour (default 4am) in the user's local timezone.
 *
 * Returns a UTC Date suitable for database queries (e.g., `lastReview >= startOfDay`).
 *
 * This is a per-learner "study day". Anything compared with what the grader
 * stamps (daily view counts, fail floors, review counts) uses
 * getCourseDayStart instead, which is the grader's boundary.
 */
export function getStudyDayStart(
  now: Date,
  // Required, so a caller cannot get UTC midnight by leaving it out. Pass
  // `undefined` only when no timezone is known at all.
  tz: string | undefined,
  resetHour = 4,
): Date {
  if (!tz) {
    // No timezone: fall back to UTC midnight
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  let parts: Record<string, string>;
  try {
    parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(now)
      .forEach((p) => {
        parts[p.type] = p.value;
      });
  } catch {
    // Invalid timezone: fall back to UTC midnight
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  // Intl can return '24' for midnight in some locales
  const localHour = parseInt(parts.hour === '24' ? '0' : parts.hour);
  let year = parseInt(parts.year);
  let month = parseInt(parts.month);
  let day = parseInt(parts.day);

  // Before resetHour → still in "yesterday's" study day
  if (localHour < resetHour) {
    const prev = new Date(Date.UTC(year, month - 1, day - 1));
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
    day = prev.getUTCDate();
  }

  // Compute current UTC offset: localTime(now) - UTC(now). The formatter has
  // whole seconds, so compare against now truncated to the second; otherwise
  // the offset, and the returned boundary, carry now's milliseconds.
  const localMs = Date.UTC(
    parseInt(parts.year),
    parseInt(parts.month) - 1,
    parseInt(parts.day),
    localHour,
    parseInt(parts.minute),
    parseInt(parts.second),
  );
  const offsetMs = localMs - Math.floor(now.getTime() / 1000) * 1000;

  // Target: resetHour:00:00 on the determined date, in the user's timezone
  const targetLocalMs = Date.UTC(year, month - 1, day, resetHour, 0, 0, 0);

  return new Date(targetLocalMs - offsetMs);
}
