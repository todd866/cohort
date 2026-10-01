/**
 * The learner's study-day timezone, persisted where a SERVER render can read it.
 *
 * The browser already sends `tz` on its own session fetches. The server
 * bootstrap could not, so it could not stream a mixed review batch: that
 * timezone gates the objective-core lane — `nativeAnswersToday` and the
 * adaptive daily target (unified-session-service.ts:509-529) — and a server
 * batch computed without it could disagree with the lane the browser expects.
 *
 * Mirrors the feed-mode cookie: the browser writes it, the next navigation's
 * server render reads it, and a visit without it stays on the bounded client
 * path rather than guessing.
 */

export const STUDY_TIMEZONE_COOKIE = 'md3_study_tz';
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Validate an IANA zone. Applied on READ as well as write: the value arrives
 * as an untrusted cookie, so a server render must never pass it onward
 * unchecked.
 */
export function parseStudyTimezone(value: string | null | undefined): string | null {
  if (!value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value;
  } catch {
    return null;
  }
}

/** Cookie string for a validated zone, or null when the zone is not one. */
export function studyTimezoneCookie(timezone: string): string | null {
  const valid = parseStudyTimezone(timezone);
  if (!valid) return null;
  return [
    `${STUDY_TIMEZONE_COOKIE}=${encodeURIComponent(valid)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ].join('; ');
}
