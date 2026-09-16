'use client';

import Link from 'next/link';
import { useExamReadiness } from '@/hooks/useExamReadiness';
import { buildReviewHref } from '@/lib/review/review-intent';

interface Props {
  rotation: string;
  showWeekly?: boolean;
}

export function StudyReadinessPanel({ rotation, showWeekly = true }: Props) {
  const { data, error, isLoading } = useExamReadiness(rotation);

  if (isLoading) {
    return (
      <div className="p-4 rounded-xl bg-gray-50 animate-pulse">
        <div className="h-20 bg-gray-200 rounded" />
      </div>
    );
  }

  if (error || !data?.summary) {
    return null;
  }

  const { summary, daysToExam, topAtRisk, weeklyReadiness } = data;
  const dailyPct = Math.round(summary.dailyProgress);
  const examPredPct = Math.round(summary.examPrediction * 100);

  const progressColor = (pct: number) =>
    pct >= 80 ? 'text-green-600' : pct >= 40 ? 'text-blue-600' : 'text-gray-500';

  const masteryColor = (pct: number) =>
    pct >= 70 ? 'text-green-600' : pct >= 50 ? 'text-yellow-600' : 'text-red-600';

  return (
    <div className="space-y-3">
      {/* Mastery overview — daily progress vs exam prediction */}
      <Link
        href={buildReviewHref({ rotation })}
        className="block p-4 rounded-xl border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className={`text-2xl font-bold ${progressColor(dailyPct)}`}>
              {dailyPct}%
            </div>
            <div className="text-xs text-gray-400 mt-1">today</div>
          </div>
          <div className="text-gray-300 text-lg">{'\u2192'}</div>
          <div className="text-right">
            <div className={`text-2xl font-bold ${masteryColor(examPredPct)}`}>
              {examPredPct}%
            </div>
            <div className="text-xs text-gray-400 mt-1">
              exam score{daysToExam != null ? ` · ${daysToExam}d` : ''}
            </div>
          </div>
        </div>

        {/* Compact stats */}
        <div className="flex gap-4 mt-3 text-xs text-gray-500">
          <span>{summary.todayReviewed}/{summary.requiredDailyReviews} today</span>
          <span>{'\u00b7'}</span>
          <span>{summary.reviewedCards}/{summary.totalCards} covered</span>
        </div>
      </Link>

      {/* At-Risk Cards */}
      {topAtRisk && topAtRisk.length > 0 && (
        <div className="p-4 rounded-xl border border-red-200 bg-red-50">
          <h4 className="font-medium text-red-800 mb-2 text-sm">At Risk Topics</h4>
          <div className="space-y-1.5">
            {topAtRisk.slice(0, 3).map((card) => (
              <div key={card.cardId} className="flex items-center justify-between text-sm">
                <span className="text-red-700 truncate max-w-[200px]">
                  {card.front.replace(/\[___\]/g, '___').slice(0, 50)}...
                </span>
                <span className="text-red-500 text-xs">
                  Week {card.week} · {Math.round(card.examDayStrength * 100)}%
                </span>
              </div>
            ))}
          </div>
          <Link
            href={buildReviewHref({ rotation, filter: 'at-risk' })}
            className="block mt-2 text-center text-sm text-red-600 hover:text-red-800 font-medium"
          >
            Review at-risk cards
          </Link>
        </div>
      )}

      {/* Weekly Breakdown */}
      {showWeekly && weeklyReadiness && weeklyReadiness.length > 0 && (
        <div className="p-4 rounded-xl border border-gray-200 bg-white">
          <h4 className="font-medium text-gray-700 mb-3 text-sm">Weekly Readiness</h4>
          <div className="space-y-2">
            {weeklyReadiness.map((week) => (
              <div key={week.week} className="flex items-center gap-2">
                <span className="w-14 text-xs text-gray-500">Wk {week.week}</span>
                <div className="flex-grow h-2.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      week.avgExamDayStrength >= 0.7 ? 'bg-green-500' :
                      week.avgExamDayStrength >= 0.5 ? 'bg-yellow-500' :
                      'bg-red-500'
                    }`}
                    style={{ width: `${Math.round(week.avgExamDayStrength * 100)}%` }}
                  />
                </div>
                <span className="w-10 text-xs text-gray-600 text-right">
                  {Math.round(week.avgExamDayStrength * 100)}%
                </span>
                {week.atRiskCount > 0 && (
                  <span className="text-xs text-red-500">{week.atRiskCount}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compact version for embedding in week cards
 */
export function WeekMasteryBadge({ rotation, week }: { rotation: string; week: number }) {
  const { data } = useExamReadiness(rotation);

  if (!data?.weeklyReadiness) return null;

  const weekData = data.weeklyReadiness.find((w) => w.week === week);
  if (!weekData) return null;

  const percent = Math.round(weekData.avgExamDayStrength * 100);
  const colorClass =
    percent >= 70 ? 'bg-green-100 text-green-700' :
    percent >= 50 ? 'bg-yellow-100 text-yellow-700' :
    'bg-red-100 text-red-700';

  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${colorClass}`}>
      {percent}%
    </span>
  );
}
