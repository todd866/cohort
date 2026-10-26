'use client';

import { CHIP_SHAPE } from '@/components/shared/Chip';
import type { ProgressKind } from './progress-presentation';
import {
  BAND_LABEL,
  dailyBand,
  dailyGoals,
  type GoalBand,
} from '@/lib/study/daily-goals';

interface ProgressPillProps {
  reviewed: number;
  target: number | null;
  onTap: () => void;
  kind?: ProgressKind;
}

// The fill colour carries the band (src/lib/study/daily-goals.ts).
const BAND_FILL: Record<GoalBand, string> = {
  // Owner, 17 Oct: red, then yellow approaching the target, green at it, dark
  // green past it. A red fill, never a cross: learners read a cross as 'wrong'.
  red: 'bg-[color-mix(in_srgb,var(--md-error)_16%,transparent)]',
  yellow: 'bg-[color-mix(in_srgb,var(--md-warning)_22%,transparent)]',
  green: 'bg-[color-mix(in_srgb,var(--md-success)_22%,transparent)]',
  'dark-green': 'bg-[color-mix(in_srgb,var(--md-success)_45%,transparent)]',
};

export function ProgressPill({ reviewed, target, onTap, kind = 'daily' }: ProgressPillProps) {
  const goals = dailyGoals(kind === 'session' ? null : target);
  const band = goals ? dailyBand(reviewed, goals) : null;
  // The target is the only number shown; past it, the count alone and the
  // colour say how far (src/lib/study/daily-goals.ts).
  const toGo = goals != null && reviewed < goals.target;
  const fillWidth = goals ? `${toGo ? Math.round((reviewed / goals.target) * 100) : 100}%` : '0%';

  const label = kind === 'session'
    ? `This session: ${reviewed} reviewed. Open whole-course progress.`
    : kind === 'new'
    ? `New today: ${reviewed}${goals && band ? ` of ${goals.target}, ${BAND_LABEL[band]}` : ''}. Open whole-course progress.`
    : goals && band
    ? `Today ${reviewed} of ${goals.target} reviews, ${BAND_LABEL[band]}.`
    : `${reviewed} reviewed`;

  // Below 26rem the chip drops its minimum width and padding so a phone
  // toolbar (back, course, progress, connection, AI, flag, options) fits at
  // 360 px without clipping anything (15 Oct 2026).
  return (
    <button
      onClick={onTap}
      aria-label={label}
      className={`${CHIP_SHAPE} relative shrink-0 min-w-[72px] @max-[26rem]/review-toolbar:min-w-0 @max-[26rem]/review-toolbar:px-[8px] justify-center overflow-hidden bg-[var(--md-surface)] border-[var(--md-outline-variant)]`}
    >
      {band && (
        <div
          className={`absolute inset-y-0 left-0 ${BAND_FILL[band]}`}
          style={{ width: fillWidth }}
        />
      )}

      <span className="relative flex items-center justify-center gap-1.5 text-[var(--md-on-surface)] tabular-nums">
        {kind === 'session' ? <span>Session {reviewed}</span> : goals ? (
          <span>{kind === 'new' ? 'New ' : ''}{toGo ? `${reviewed}/${goals.target}` : reviewed}</span>
        ) : (
          <span>{kind === 'new' ? `New ${reviewed}` : `${reviewed} reviewed`}</span>
        )}
      </span>
    </button>
  );
}
