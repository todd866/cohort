'use client';

import { useState } from 'react';
import { goalProgressText, type GoalBand } from '@/lib/study/daily-goals';
import Link from 'next/link';
import type { RotationProgressBreakdown } from './hooks/useSessionProgress';
import { visibleProgressRotations } from './progress-rotation-filter';
import type { BookedExam } from '@/lib/study/booked-exam';
import type { TopicReadinessSummary } from '@/lib/knowledge/topic-heat';
import { useTopicReadiness } from './hooks/useTopicReadiness';
import type { ReviewFeedMode } from '@/lib/review/feed-mode';

interface ProgressDrawerProps {
  open: boolean;
  /** Aggregate (sum across rotations) — used when there's no per-rotation breakdown. */
  reviewed: number;
  target: number | null;
  /** Per-rotation breakdown (null while loading). */
  perRotation: RotationProgressBreakdown[] | null;
  /** This session's review count + accuracy (in-memory, not server). */
  sessionReviewed: number;
  sessionAccuracy: number;
  /** The rotation being studied, so it is shown alongside the exam rotation. */
  currentRotation?: string | null;
  /** The booked sitting, resolved across every active rotation rather than the
   *  ones this session fetched. The countdown is what the drawer is FOR, and
   *  focusing a self-paced deck returns a payload with no exam-bearing row at
   *  all — so it cannot be derived from `perRotation`. */
  bookedExam?: BookedExam | null;
  feedMode?: ReviewFeedMode;
  scoped?: boolean;
}

function formatRotation(rotation: string): string {
  if (rotation === 'usmle-step1-open') return 'USMLE Step 1';
  return rotation
    .split('-')
    .map((w) => (w.toLowerCase() === 'cah' || w.toLowerCase() === 'pwh' ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function formatDays(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** En dash, so an unknown count occupies the same line as the number that replaces it. */
const UNKNOWN_COUNT = '\u2013';

function topicCount(value: number | null | undefined): string {
  return value == null ? UNKNOWN_COUNT : formatCount(value);
}

function ExamDays({ days }: { days: number }) {
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-[var(--md-on-surface-variant)]">
      {formatDays(days)}
    </span>
  );
}

/** Today and first-sight on one line. The glyph and colour are the day's goal band (src/lib/study/daily-goals.ts). */
function TodayPace({ row, feedMode, scoped }: { row: RotationProgressBreakdown; feedMode: ReviewFeedMode; scoped: boolean }) {
  const newOnly = feedMode === 'new-only';
  const reviewed = newOnly ? row.todayFirstSight ?? 0 : row.todayReviewed;
  const target = newOnly ? row.firstSightTarget ?? null : row.dailyTarget;
  const goal = goalProgressText(reviewed, target, formatCount);
  const prefix = newOnly ? 'New today' : 'Today';
  const today = `${prefix} ${goal?.text ?? formatCount(reviewed)}`;
  const newer = !newOnly && row.firstSightTarget != null
    ? ` \u00b7 New ${formatCount(row.todayFirstSight ?? 0)}/${formatCount(row.firstSightTarget)}`
    : '';

  return (
    <details className="text-sm text-[var(--md-on-surface)]">
      <summary className="cursor-pointer tabular-nums" aria-label={`${scoped ? 'Whole course. ' : ''}${today}${newer}. How today's target is calculated`}>
        {scoped && <span className="text-xs text-[var(--md-on-surface-variant)]">Whole course · </span>}
        {goal && goal.band !== 'red' && newer
          ? <><span className={GOAL_TEXT[goal.band]}>{today}</span>{newer}</>
          : <span className={goal ? GOAL_TEXT[goal.band] : ''}>{today}{newer}</span>}
      </summary>
      <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">
        {newOnly && <>New only counts first-time answers toward the new-material goal. Previously studied items, including due reviews, are excluded from this mode. </>}
        {scoped && <>These daily counts cover the whole course, not just this session. </>}
        Your target balances recent study pace, due reviews, unseen material and time to the exam.
        MCQ performance can raise it when there is enough reliable answer history.
        The goal for first-seen material is capped at half your estimated daily capacity; due reviews are spread
        over up to seven days. It is a study goal, not a measure of mastery.
      </p>
    </details>
  );
}

const GOAL_TEXT: Record<GoalBand, string> = {
  red: 'text-[var(--md-on-surface)]',
  yellow: 'text-[var(--md-warning)]',
  green: 'text-[var(--md-success)]',
  'dark-green': 'text-[var(--md-success)]',
};

/** Rotation, pool, today, and a topics row that never swaps in or out. */
function RotationHeadline({
  row,
  readiness,
  showTopics,
  feedMode,
  scoped,
}: {
  row: RotationProgressBreakdown;
  readiness: TopicReadinessSummary | null;
  showTopics: boolean;
  feedMode: ReviewFeedMode;
  scoped: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-semibold text-[var(--md-on-surface)]">
          {formatRotation(row.rotation)}
        </span>
        {row.daysToExam != null && row.daysToExam > 0 && row.examDate && (
          <ExamDays days={row.daysToExam} />
        )}
      </div>

      {row.progressPool && <ProgressPoolBar row={row} />}

      <TodayPace row={row} feedMode={feedMode} scoped={scoped} />

      {showTopics && (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <p className="text-sm tabular-nums text-[var(--md-on-surface)]">
            Topics {topicCount(readiness?.ready)} ready · {topicCount(readiness?.slipping)} learning · {topicCount(readiness?.unseen)} unseen
          </p>
          <Link
            href="/profile#topic-readiness"
            className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap text-xs font-semibold text-[var(--md-primary)] hover:underline"
          >
            Topic map →
          </Link>
        </div>
      )}
    </div>
  );
}

const POOL_BANDS = [
  { key: 'learned', label: 'Learned', color: 'bg-[var(--md-success)]', detail: 'recalled successfully last time' },
  { key: 'learning', label: 'Learning', color: 'bg-[var(--md-primary)]', detail: 'seen, without a clear pass or fail yet' },
  { key: 'shaky', label: 'Shaky', color: 'bg-[var(--md-tertiary)]', detail: 'missed on the last recall' },
  { key: 'unseen', label: 'Unseen', color: 'bg-[var(--md-surface-container-highest)]', detail: 'not seen yet' },
] as const;

function ProgressPoolBar({ row }: { row: RotationProgressBreakdown }) {
  const pool = row.progressPool!;
  const [activeBand, setActiveBand] = useState<(typeof POOL_BANDS)[number]['key'] | null>(null);
  const selected = POOL_BANDS.find((band) => band.key === activeBand);
  const detailId = `progress-pool-detail-${row.rotation.replace(/[^a-z0-9-]/gi, '-')}`;

  return (
    <div className="space-y-1.5" role="group" aria-label={`Study pool progress across ${pool.total} servable items`}>
      <div className="flex h-6 w-full overflow-hidden rounded-full" role="group" aria-label="Learned, learning, shaky, unseen">
        {POOL_BANDS.map((band) => {
          const count = pool[band.key];
          const share = pool.total > 0 ? (count / pool.total) * 100 : 0;
          return (
            <button
              key={band.key}
              type="button"
              className={`${band.color} min-w-10 border-r border-[var(--md-surface)] last:border-r-0 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--md-on-surface)]`}
              style={{ flexGrow: Math.max(share, 0.01) }}
              aria-label={`${band.label}: ${count} of ${pool.total}, ${band.detail}`}
              aria-describedby={detailId}
              onMouseEnter={() => setActiveBand(band.key)}
              onFocus={() => setActiveBand(band.key)}
              onClick={() => setActiveBand(band.key)}
            />
          );
        })}
      </div>
      <p id={detailId} aria-live="polite" className="min-h-5 text-sm tabular-nums text-[var(--md-on-surface)]">
        {selected
          ? `${selected.label}: ${formatCount(pool[selected.key])} of ${formatCount(pool.total)} items ${selected.detail}.`
          : POOL_BANDS.map((band) => `${formatCount(pool[band.key])} ${band.label.toLowerCase()}`).join(' · ')}
      </p>
    </div>
  );
}

export function ProgressDrawer({
  open,
  reviewed,
  target,
  perRotation,
  sessionReviewed,
  sessionAccuracy,
  currentRotation,
  bookedExam,
  feedMode = 'mixed',
  scoped = false,
}: ProgressDrawerProps) {
  const hasRotations = perRotation && perRotation.length > 0;
  const rows = hasRotations
    ? visibleProgressRotations(perRotation, currentRotation ?? null)
    : [];
  const readinessRotation = rows[0]?.rotation ?? bookedExam?.rotation ?? null;
  const readiness = useTopicReadiness(open, readinessRotation);
  // Only when the fetched rows do not already carry it, or the exam appears
  // twice — once as a full readiness row and once as a bare countdown.
  const countdown = bookedExam
    && !rows.some((row) => row.rotation === bookedExam.rotation)
    ? bookedExam
    : null;

  return (
    <div
      className={`transition-all duration-300 ease-out ${
        open
          ? 'mt-2 max-h-[min(70vh,42rem)] overflow-y-auto opacity-100'
          : 'max-h-0 overflow-hidden opacity-0'
      }`}
    >
      <div className="rounded-lg bg-[var(--md-surface-container)] p-4 text-[var(--md-on-surface-variant)] space-y-5">
        {countdown && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-base font-semibold text-[var(--md-on-surface)]">
              {formatRotation(countdown.rotation)}
            </span>
            <ExamDays days={countdown.daysToExam} />
          </div>
        )}
        {hasRotations ? (
          rows.map((row) => (
            <RotationHeadline
              key={row.rotation}
              row={row}
              readiness={readiness?.rotation === row.rotation ? readiness : null}
              showTopics={row.rotation === readinessRotation}
              feedMode={feedMode}
              scoped={scoped}
            />
          ))
        ) : (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-base font-semibold text-[var(--md-on-surface)]">Today</span>
            <span className="tabular-nums text-sm text-[var(--md-on-surface)]">
              {goalProgressText(reviewed, target)?.text.concat(' cards') ?? `${reviewed} reviewed`}
            </span>
          </div>
        )}

        {sessionReviewed > 0 && (
          <div className="border-t border-[var(--md-outline-variant)] pt-2 text-xs tabular-nums opacity-60">
            this session {sessionReviewed} · {sessionAccuracy}%
          </div>
        )}
      </div>
    </div>
  );
}
