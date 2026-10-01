'use client';

import type { CurriculumPosition, UpcomingExam } from '@/lib/curriculum/types';

interface CurriculumStatusProps {
  position: CurriculumPosition;
  compact?: boolean;
}

function daysLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `${days} days`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? '1 week' : `${weeks} weeks`;
}

function ExamBadge({ exam }: { exam: UpcomingExam }) {
  const urgency =
    exam.daysUntil <= 7
      ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
      : exam.daysUntil <= 14
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
        : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]';

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${urgency}`}>
      <span>{exam.name}</span>
      <span className="opacity-70">{daysLabel(exam.daysUntil)}</span>
    </span>
  );
}

export function CurriculumStatus({ position, compact = false }: CurriculumStatusProps) {
  if (compact) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-[var(--md-on-surface-variant)]">Week {position.currentWeek}</span>
        <span className="text-[var(--md-outline)]">•</span>
        <span className="font-medium text-[var(--md-on-surface)]">{position.blockName}</span>
        {position.upcomingExams.slice(0, 1).map(exam => (
          <ExamBadge key={exam.id} exam={exam} />
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-[var(--md-on-surface-variant)] uppercase tracking-wide mb-1">
            Week {position.currentWeek}
          </div>
          <div className="text-lg font-semibold text-[var(--md-on-surface)]">
            {position.blockName}
          </div>
          <div className="text-sm text-[var(--md-on-surface-variant)] mt-0.5">
            {position.weekTitle}
          </div>
        </div>

        <div className="flex flex-col gap-1 items-end">
          {position.upcomingExams.map(exam => (
            <ExamBadge key={exam.id} exam={exam} />
          ))}
        </div>
      </div>

      {position.continuousTracks.length > 0 && (
        <div className="mt-4 pt-3 border-t border-[var(--md-outline-variant)]">
          <div className="text-xs text-[var(--md-on-surface-variant)] mb-2">
            Continuous Tracks
          </div>
          <div className="flex gap-3">
            {position.continuousTracks.map(track => (
              <div key={track.id} className="flex-1">
                <div className="text-xs text-[var(--md-on-surface-variant)] mb-1">
                  {track.name}
                </div>
                <div className="h-1.5 bg-[var(--md-surface-container-high)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--md-primary)] rounded-full transition-all"
                    style={{ width: `${Math.round(track.progress * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function CurriculumStatusSkeleton() {
  return (
    <div className="p-4 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] animate-pulse">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="h-3 w-12 bg-[var(--md-outline-variant)] rounded mb-2" />
          <div className="h-6 w-32 bg-[var(--md-outline-variant)] rounded mb-1" />
          <div className="h-4 w-48 bg-[var(--md-outline-variant)] rounded" />
        </div>
        <div className="flex flex-col gap-1 items-end">
          <div className="h-5 w-20 bg-[var(--md-outline-variant)] rounded-full" />
          <div className="h-5 w-24 bg-[var(--md-outline-variant)] rounded-full" />
        </div>
      </div>
    </div>
  );
}
