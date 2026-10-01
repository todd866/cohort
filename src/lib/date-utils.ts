// Shared date utility functions

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Calculate the number of days between two dates.
 * Returns 0 if date1 is after date2.
 */
export function daysBetween(date1: Date, date2: Date): number {
  return Math.max(0, (date2.getTime() - date1.getTime()) / ONE_DAY_MS);
}

/**
 * Calculate days since a given date from now.
 */
export function daysSince(date: Date, now: Date = new Date()): number {
  return daysBetween(date, now);
}

/**
 * Calculate days until a future date from now.
 * Returns 0 if the date is in the past.
 */
export function daysUntil(futureDate: Date, now: Date = new Date()): number {
  return daysBetween(now, futureDate);
}
