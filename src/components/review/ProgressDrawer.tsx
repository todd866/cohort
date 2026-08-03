'use client';

import type { RotationProgressBreakdown } from './hooks/useSessionProgress';

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
}

function formatRotation(rotation: string): string {
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
): { text: string; tone: 'good' | 'neutral' | 'warn' } | null {
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
    // Both branches state the SAME quantity — how many more to do today
    // (`remaining`, coherent with the "Today N/target" line above). Only the
    // tone + verb differ: "catch up" (behind) vs "stay on pace" (on track).
    // (Earlier this showed `newPerDay` when behind, a different figure that read
    // incoherently next to the target line — e.g. "0/22 cards · 8/day to catch up".)
    if (genuinelyBehind) {
      return { text: `${remaining} more to catch up`, tone: 'warn' };
    }
    return { text: `${remaining} more to stay on pace`, tone: 'neutral' };
  }
  if (genuinelyBehind) return { text: 'behind on coverage', tone: 'warn' };
  if (target != null) return { text: "today's target met", tone: 'good' };
  return null;
}

/** The "one honest headline" block: rotation + countdown, one coverage bar, today + a single nudge. */
function RotationHeadline({ row }: { row: RotationProgressBreakdown }) {
  const coverPct = clampPct(row.coverage.percent);
  const target = row.dailyTarget;
  const reviewed = row.todayReviewed;
  const nudge = paceNudge(row);
  const nudgeClass =
    nudge?.tone === 'good'
      ? 'text-[var(--md-success)]'
      : nudge?.tone === 'warn'
        ? 'text-[var(--md-tertiary)]'
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

      {/* one coverage bar */}
      <div className="flex items-center gap-3">
        <div className="relative h-2 flex-1 rounded-full bg-[var(--md-surface-container-high)] overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--md-primary)]"
            style={{ width: `${coverPct}%` }}
          />
        </div>
        <span className="tabular-nums text-xs text-[var(--md-on-surface)]">{coverPct}% covered</span>
      </div>

      {/* today's count + a single pace nudge */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-[var(--md-on-surface)]">
          Today{' '}
          <span className="tabular-nums font-medium">
            {target != null ? `${reviewed} / ${target}` : reviewed}
          </span>
          {target != null ? ' cards' : ' reviewed'}
        </span>
        {nudge && <span className={`text-xs ${nudgeClass}`}>{nudge.text}</span>}
      </div>
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
}: ProgressDrawerProps) {
  const hasRotations = perRotation && perRotation.length > 0;

  return (
    <div
      className={`overflow-hidden transition-all duration-300 ease-out ${
        open ? 'max-h-[420px] opacity-100 mt-2' : 'max-h-0 opacity-0'
      }`}
    >
      <div className="rounded-lg bg-[var(--md-surface-container)] p-4 text-[var(--md-on-surface-variant)] space-y-5">
        {hasRotations ? (
          perRotation.map((row) => <RotationHeadline key={row.rotation} row={row} />)
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
