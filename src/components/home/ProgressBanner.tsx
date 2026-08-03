'use client';

import { useState } from 'react';
import { useSessionProgress } from '@/components/review/hooks/useSessionProgress';
import { useRotationReadiness } from '@/hooks/useRotationReadiness';

function formatExamDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

interface Props {
  rotation: string;
  rotationName: string;
  defaultOpen?: boolean;
}

/**
 * Peelable progress banner for the review/learn pages.
 *
 * Collapsed: rotation · exam countdown · today's count.
 * Expanded: mastery, per-week coverage, focus areas (weak concepts), unseen.
 * Stays out of the way during review; one tap when you want context.
 */
export function ProgressBanner({ rotation, rotationName, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const progress = useSessionProgress(rotation);
  const readiness = useRotationReadiness(open ? rotation : null);

  if (progress.loading) return null;

  const examLabel = progress.daysToExam != null && progress.examDate
    ? `${progress.daysToExam}d · ${formatExamDate(progress.examDate)}`
    : null;
  const todayLabel = progress.reviewed != null
    ? `${progress.reviewed}${progress.target ? `/${progress.target}` : ''}`
    : null;

  return (
    <div className="border-b border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-2 flex items-center justify-between gap-3 text-sm hover:bg-[var(--md-surface-container)] transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 text-[var(--md-on-surface)]">
          <span className="font-medium">{rotationName}</span>
          {examLabel && (
            <span className="text-[var(--md-on-surface-variant)]">· exam {examLabel}</span>
          )}
          {todayLabel && (
            <span className="text-[var(--md-on-surface-variant)]">
              · today {todayLabel}
              {progress.targetHit && <span className="ml-1 text-[var(--md-tertiary)]">✓</span>}
            </span>
          )}
        </div>
        <span className="text-xs text-[var(--md-on-surface-variant)]">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && readiness.data && (
        <div className="px-4 pb-4 pt-2 space-y-4">
          {readiness.data.mastery > 0 && (
            <ProgressRow
              label="Mastery"
              value={`${readiness.data.mastery}%`}
              percent={readiness.data.mastery}
              color="var(--md-tertiary)"
            />
          )}
          {progress.coverage && (
            <ProgressRow
              label="Coverage"
              value={`${progress.coveragePercent}%`}
              percent={progress.coveragePercent ?? 0}
              color="var(--md-primary)"
            />
          )}
          {readiness.data.weeklyProgress.length > 0 && (
            <div>
              <div className="text-xs font-medium text-[var(--md-on-surface-variant)] mb-2">
                By week
              </div>
              <div className="space-y-1.5">
                {readiness.data.weeklyProgress.map((w) => (
                  <div key={String(w.week)} className="flex items-center gap-2">
                    <span className="text-xs text-[var(--md-on-surface-variant)] w-8">
                      W{w.week ?? '?'}
                    </span>
                    <div className="flex-1 h-1.5 rounded-full bg-[var(--md-surface-container-high)] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[var(--md-primary)] transition-all"
                        style={{ width: `${Math.min(100, w.coverage)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-[var(--md-on-surface-variant)] w-8 text-right">
                      {w.coverage}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {readiness.data.conceptMastery.weak.length > 0 && (
            <div>
              <div className="text-xs font-medium text-[var(--md-on-surface-variant)] mb-2">
                Focus areas
              </div>
              <div className="flex flex-wrap gap-1.5">
                {readiness.data.conceptMastery.weak.slice(0, 8).map((t) => (
                  <span
                    key={t.concept}
                    className="px-2 py-0.5 rounded-full bg-[var(--md-error-container)] text-[var(--md-on-error-container)] text-xs capitalize"
                    title={`${t.cardCount} card${t.cardCount === 1 ? '' : 's'}`}
                  >
                    {t.concept}
                    <span className="opacity-70 ml-1">{t.mastery}%</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressRow({ label, value, percent, color }: { label: string; value: string; percent: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-[var(--md-on-surface-variant)]">{label}</span>
        <span className="text-sm text-[var(--md-on-surface)]">{value}</span>
      </div>
      <div className="w-full h-2 rounded-full bg-[var(--md-surface-container-high)]">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, percent)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
