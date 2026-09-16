/**
 * Midnight in a named timezone.
 *
 * Lives in its own leaf module with no database import, so both a server
 * component and a CLI script can share one definition. "Today" is the answer
 * people mean when they ask who is using the app — a rolling N-hour window
 * silently drops a study session that finished an hour before it opened.
 */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const secondsIntoDay = (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
  return new Date(+now - secondsIntoDay * 1000 - now.getMilliseconds());
}
