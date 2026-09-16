'use client';

import { useExamReadiness } from '@/hooks/useExamReadiness';
import Link from 'next/link';
import { buildReviewHref } from '@/lib/review/review-intent';

interface Props {
  rotation: string;
}

export function ExamCountdown({ rotation }: Props) {
  const { data, isLoading } = useExamReadiness(rotation);

  if (isLoading || !data) {
    return (
      <div className="rounded-xl bg-[var(--md-surface-container)] p-6 animate-pulse h-24" />
    );
  }

  const { daysToExam, summary } = data;
  const predictionPct = Math.round((summary.examPrediction ?? 0) * 100);

  return (
    <div className="rounded-xl bg-[var(--md-surface-container)] p-6">
      <div className="flex items-center justify-between gap-4">
        {daysToExam !== null && (
          <div className="text-center">
            <div className="text-3xl font-bold text-[var(--md-on-surface)]">
              {daysToExam}
            </div>
            <div className="text-xs text-[var(--md-on-surface-variant)]">
              days to exam
            </div>
          </div>
        )}

        <div className="text-center">
          <div className={`text-3xl font-bold ${predictionPct >= 70 ? 'text-green-600' : predictionPct >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
            {predictionPct}%
          </div>
          <div className="text-xs text-[var(--md-on-surface-variant)]">
            predicted score
          </div>
        </div>

        <div className="text-center">
          <div className="text-lg font-semibold text-[var(--md-on-surface)]">
            {summary.todayReviewed} / {summary.requiredDailyReviews}
          </div>
          <div className="text-xs text-[var(--md-on-surface-variant)]">
            cards today
          </div>
        </div>

        <Link
          href={buildReviewHref({ rotation })}
          className="shrink-0 px-4 py-2 rounded-full bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium text-sm hover:opacity-90 transition-opacity"
        >
          Start Review
        </Link>
      </div>
    </div>
  );
}
