/**
 * One dumbbell. You is a filled primary dot, cohort a filled neutral dot,
 * md3 or a practice paper an outline ring. Close marks become one marker.
 */
import { placeMarks, type PlacedMark } from '@/lib/stats/score-marks';

export function ScoreTrack({
  youAt,
  cohortAt,
  ringAts = [],
  label,
}: {
  youAt: number | null;
  cohortAt: number | null;
  ringAts?: Array<number | null>;
  label: string;
}) {
  const marks = [
    ...(youAt == null ? [] : [{ at: youAt, kind: 'you' as const }]),
    ...(cohortAt == null ? [] : [{ at: cohortAt, kind: 'cohort' as const }]),
    ...ringAts.filter((at): at is number => at != null).map((at) => ({ at, kind: 'ring' as const })),
  ];
  const placed = placeMarks(marks);
  const ends = [youAt, cohortAt].filter((at): at is number => at != null);
  const line = ends.length === 2 ? { left: Math.min(...ends), width: Math.abs(ends[0]! - ends[1]!) } : null;
  return (
    <span className="relative block h-3" role="img" aria-label={label}>
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-[var(--md-outline-soft)]" />
      {line && line.width > 0 && (
        <span aria-hidden className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-[var(--md-on-surface-variant)]"
          style={{ left: `${line.left * 100}%`, width: `${line.width * 100}%` }} />
      )}
      {placed.map((mark) => <Mark key={`${mark.at}-${mark.kinds.join('+')}`} mark={mark} />)}
    </span>
  );
}

function Mark({ mark }: { mark: PlacedMark }) {
  const you = mark.kinds.includes('you');
  const cohort = mark.kinds.includes('cohort');
  const ring = mark.kinds.includes('ring');
  const combined = you && (cohort || ring);
  const background = you || (cohort && !ring) ? (you ? 'var(--md-primary)' : 'var(--md-on-surface-variant)') : 'var(--md-surface)';
  const ringColor = cohort && you ? 'var(--md-on-surface-variant)' : 'var(--md-primary)';
  return (
    <span aria-hidden className="absolute top-1/2 h-2.5 w-2.5 rounded-full"
      data-kinds={mark.kinds.join(' ')}
      style={{
        left: `${mark.at * 100}%`,
        transform: 'translate(-50%, -50%)',
        background: ring && !you && !cohort ? 'var(--md-surface)' : background,
        border: ring && !you ? '2px solid var(--md-primary)' : undefined,
        boxShadow: combined ? `0 0 0 1.5px var(--md-surface), 0 0 0 3px ${ringColor}` : undefined,
      }} />
  );
}
