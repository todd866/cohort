import { COURSE_TIME_ZONE, getActiveRotations, type TrackNumber } from '@/lib/rotation-context';
import { isMd2Program, md2FocusRotation } from '@/lib/md2-program';

/** Today's date in the course time zone, as YYYY-MM-DD. */
function courseDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: COURSE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * The rotation a learner is "in" today, which `resolvePrimaries` prefers over
 * module order. Year 3 reads it from the stream's block calendar. A second-year
 * has no stream, so it comes from the exam calendar: the deck for their next
 * sitting. Anyone else has none.
 */
export function currentActiveRotations(args: {
  track: number | null | undefined;
  institution: string | null | undefined;
  now?: Date;
}): string[] {
  const { track } = args;
  if (Number.isInteger(track) && track! >= 1 && track! <= 4) {
    return getActiveRotations(track as TrackNumber);
  }
  if (isMd2Program(args.institution)) return [md2FocusRotation(courseDay(args.now ?? new Date()))];
  return [];
}
