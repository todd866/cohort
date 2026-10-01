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

const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

/**
 * One plain-language pace line. Deliberately NO alarm red — the strongest
 * tone is the brand's tertiary (clay), reserved for "genuinely behind". We
 * answer "how am I doing?" calmly instead of shouting a 0% projection.
 */
function paceNudge(
  row: RotationProgressBreakdown,
): { text: string; tone: 'good' | 'neutral' } | null {
  // No deadline (self-paced rotations like the AnKing background deck) → there
  // is nothing to be "behind" or "on pace" for. The projection still reports
  // finalOverallPercent = currentPercent, which would otherwise trip the
  // "behind on coverage" branch below; suppress the whole nudge instead.
  if (row.daysToExam == null) return null;

  const target = row.dailyTarget;
  const reviewed = row.todayReviewed;
  const remaining = target != null ? Math.max(0, target - reviewed) : 0;
  const final = row.projection?.finalOverallPercent ?? null;
  const genuinelyBehind = final != null && final < 70;

  if (target != null && remaining > 0) {
    // Keep the same remaining-today quantity without treating the schedule as
    // a debt or implying that the target itself measures full-pool readiness.
    return { text: `${remaining} remaining today`, tone: 'neutral' };
  }
  if (genuinelyBehind) return { text: 'full-pool coverage still in progress', tone: 'neutral' };
  if (target != null) return { text: "today's target met", tone: 'good' };
  return null;
}

/** The "one honest headline" block: rotation + countdown, one coverage bar, today + a single nudge. */
function RotationHeadline({
  row,
  readiness,
}: {
  row: RotationProgressBreakdown;
  readiness: TopicReadinessSummary | null;
}) {
  const coverPct = clampPct(row.coverage.percent);
  const target = row.dailyTarget;
  const reviewed = row.todayReviewed;
  const nudge = paceNudge(row);
  const nudgeClass =
    nudge?.tone === 'good'
      ? 'text-[var(--md-success)]'
      : 'text-[var(--md-on-surface-variant)]';

  return (
    <div className="space-y-2">
      {/* rotation + exam countdown */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-semibold text-[var(--md-on-surface)]">
          {formatRotation(row.rotation)}
        </span>
        {row.daysToExam != null && row.daysToExam > 0 && row.examDate && (
          <span className="text-xs text-[var(--md-on-surface-variant)] whitespace-nowrap">
            exam in {row.daysToExam} {row.daysToExam === 1 ? 'day' : 'days'}
          </span>
        )}
      </div>

      {readiness && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg bg-[var(--md-surface-container-low)] px-3 py-2">
          <div>
            <p className="text-sm font-medium tabular-nums text-[var(--md-on-surface)]">
              {readiness.ready} ready · {readiness.slipping} slipping · {readiness.unseen} unseen
            </p>
            <p className="text-xs tabular-nums text-[var(--md-on-surface-variant)]">
              {readiness.total} topics
            </p>
          </div>
          <Link
            href="/profile#topic-readiness"
            className="inline-flex min-h-11 items-center text-xs font-semibold text-[var(--md-primary)] hover:underline"
          >
            Open topic map →
          </Link>
        </div>
      )}

      {!readiness && (
        <div className="flex items-center gap-3">
          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-[var(--md-surface-container-high)]">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[var(--md-primary)]"
              style={{ width: `${coverPct}%` }}
            />
          </div>
          <span className="tabular-nums text-xs text-[var(--md-on-surface)]">
            {row.coverage.totalTopics
              ? `${coverPct}% · ${row.coverage.coveredTopics ?? 0} / ${row.coverage.totalTopics} topics`
              : `${coverPct}% covered`}
          </span>
        </div>
      )}

      {/* today's total and first-sight pace */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-[var(--md-on-surface)]">
          Today total{' '}
          <span className="tabular-nums font-medium">
            {target != null ? `${reviewed} / ${target}` : reviewed}
          </span>
          {target == null ? ' reviewed' : ''}
        </span>
        {nudge && <span className={`text-xs ${nudgeClass}`}>{nudge.text}</span>}
      </div>

      {row.firstSightTarget != null && (
        <div className="flex items-baseline justify-between gap-3 text-sm text-[var(--md-on-surface)]">
          <span>
            First-sight{' '}
            <span className="tabular-nums font-medium">
              {row.todayFirstSight ?? 0} / {row.firstSightTarget}
            </span>
          </span>
          <span className="text-xs text-[var(--md-on-surface-variant)]">
            minimum new material
          </span>
        </div>
      )}

      {row.progressPool && <ProgressPoolBar row={row} />}

      <details className="text-xs text-[var(--md-on-surface-variant)]">
        <summary className="flex min-h-11 cursor-pointer select-none items-center">
          <span className="tabular-nums">
            {row.coverage.seen} / {row.coverage.total} items touched
          </span>
        </summary>
        <p className="mt-1 leading-relaxed">
          Cards {row.coverage.seenCards}/{row.coverage.totalCards} · questions{' '}
          {row.coverage.seenQuestions}/{row.coverage.totalQuestions}
          {row.newPerDay != null
            ? ` · full-pool pace ${row.newPerDay}/day (planning only)`
            : ''}
          {row.reviewsPerDay != null ? ` · due pace ${row.reviewsPerDay}/day` : ''}
        </p>
      </details>
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
      <p id={detailId} aria-live="polite" className="min-h-4 text-xs text-[var(--md-on-surface-variant)]">
        {selected
          ? `${selected.label}: ${pool[selected.key]} of ${pool.total} items ${selected.detail}.`
          : `${pool.total} servable items: ${POOL_BANDS.map((band) => `${band.label.toLowerCase()} ${pool[band.key]}`).join(' · ')}.`}
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
            <span className="text-xs text-[var(--md-on-surface-variant)] whitespace-nowrap">
              exam in {countdown.daysToExam} {countdown.daysToExam === 1 ? 'day' : 'days'}
            </span>
          </div>
        )}
        {hasRotations ? (
          rows.map((row) => (
            <RotationHeadline
              key={row.rotation}
              row={row}
              readiness={readiness?.rotation === row.rotation ? readiness : null}
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
          <div className="border-t border-[var(--md-outline-variant)] pt-2 text-xs opacity-60">
            this session: {sessionReviewed} reviewed {'·'} {sessionAccuracy}% accuracy
          </div>
        )}
      </div>
    </div>
  );
}
