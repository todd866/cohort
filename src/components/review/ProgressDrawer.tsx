'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { RotationProgressBreakdown } from './hooks/useSessionProgress';
import { visibleProgressRotations } from './progress-rotation-filter';
import type { BookedExam } from '@/lib/study/booked-exam';
import type { TopicReadinessSummary } from '@/lib/knowledge/topic-heat';
import { useTopicReadiness } from './hooks/useTopicReadiness';

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

/** Today and first-sight on one line. A met target is the check, in the success token. */
function TodayPace({ row }: { row: RotationProgressBreakdown }) {
  const target = row.dailyTarget;
  const reviewed = row.todayReviewed;
  const met = target != null && reviewed >= target;
  const today = target != null
    ? `Today ${formatCount(reviewed)}/${formatCount(target)}${met ? ' \u2713' : ''}`
    : `Today ${formatCount(reviewed)}`;
  const newer = row.firstSightTarget != null
    ? ` \u00b7 New ${formatCount(row.todayFirstSight ?? 0)}/${formatCount(row.firstSightTarget)}`
    : '';

  if (met && newer) {
    return (
      <p className="text-sm tabular-nums text-[var(--md-on-surface)]">
        <span className="text-[var(--md-success)]">{today}</span>
        {newer}
      </p>
    );
  }

  return (
    <p className={`text-sm tabular-nums ${met ? 'text-[var(--md-success)]' : 'text-[var(--md-on-surface)]'}`}>
      {today}{newer}
    </p>
  );
}

/** Rotation, pool, today, and a topics row that never swaps in or out. */
function RotationHeadline({
  row,
  readiness,
  showTopics,
}: {
  row: RotationProgressBreakdown;
  readiness: TopicReadinessSummary | null;
  showTopics: boolean;
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

      <TodayPace row={row} />

      {showTopics && (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <p className="text-sm tabular-nums text-[var(--md-on-surface)]">
            Topics {topicCount(readiness?.ready)} ready · {topicCount(readiness?.slipping)} slipping · {topicCount(readiness?.unseen)} unseen
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
              title={`${band.label}: ${count} of ${pool.total} — ${band.detail}`}
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
            />
          ))
        ) : (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-base font-semibold text-[var(--md-on-surface)]">Today</span>
            <span className="tabular-nums text-sm text-[var(--md-on-surface)]">
              {target != null ? `${reviewed} / ${target} cards` : `${reviewed} reviewed`}
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
