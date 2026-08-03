/**
 * Compute the start of the current "study day" — resets at a configurable
 * hour (default 4am) in the user's local timezone.
 *
 * Returns a UTC Date suitable for database queries (e.g., `lastReview >= startOfDay`).
 */
export function getStudyDayStart(
  now: Date = new Date(),
  tz?: string,
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

  // Compute current UTC offset: localTime(now) - UTC(now)
  const localMs = Date.UTC(
    parseInt(parts.year),
    parseInt(parts.month) - 1,
    parseInt(parts.day),
    localHour,
    parseInt(parts.minute),
    parseInt(parts.second),
  );
  const offsetMs = localMs - now.getTime();

  // Target: resetHour:00:00 on the determined date, in the user's timezone
  const targetLocalMs = Date.UTC(year, month - 1, day, resetHour, 0, 0, 0);

  return new Date(targetLocalMs - offsetMs);
}
