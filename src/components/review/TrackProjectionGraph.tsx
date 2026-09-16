'use client';

import type { TrackProjection } from '@/lib/study/track-projection';

interface TrackProjectionGraphProps {
  projection: TrackProjection;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatRate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

interface SparklineProps {
  values: number[];
  height?: number;
  width?: number;
}

function Sparkline({ values, height = 24, width = 168 }: SparklineProps) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const gap = 1;
  const bandWidth = (width - gap * (values.length - 1)) / values.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block h-6 w-full"
      role="img"
      aria-label="Daily activity, last 14 days"
    >
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * (height - 2));
        const x = i * (bandWidth + gap);
        const y = height - h;
        const isToday = i === values.length - 1;
        const fill = isToday ? 'var(--md-primary)' : 'var(--md-outline)';
        return <rect key={i} x={x} y={y} width={bandWidth} height={h} fill={fill} rx="0.5" />;
      })}
    </svg>
  );
}

export function TrackProjectionGraph({ projection }: TrackProjectionGraphProps) {
  const noExam = projection.daysToExam === null;
  const onPace = projection.onTrackOverall;

  // Sparkline shows TOTAL daily activity (cards + MCQs touched, including
  // repeats), oldest → newest. That's the number the student sees on the
  // pill all day, so it lines up with their lived experience instead of
  // sneaking in the harder-to-explain first-seen series.
  const sparklineValues = projection.dailyTotalItemsHistory.length > 0
    ? [...projection.dailyTotalItemsHistory].reverse()
    : [];

  const currentPercent = Math.min(100, Math.max(0, projection.currentPercent));
  const projectedPercent = Math.min(100, Math.max(0, projection.finalOverallPercent));

  // Status line: lead with TOTAL daily-cards pace vs the adaptive
  // dailyTarget. The cover-everything new-items floor (recentNewPerDay vs
  // requiredPerDay) was confusing in isolation — "need 11/day" sounded
  // like nothing — so we put the breakdown in the secondary line and keep
  // the headline framed as believable total work.
  let statusText: string;
  let statusClass = 'text-[var(--md-on-surface)]';
  if (noExam) {
    statusText = `${formatPercent(currentPercent)} covered · no exam date set`;
    statusClass = 'text-[var(--md-on-surface-variant)]';
  } else {
    const pace = formatRate(projection.recentTotalPerDay);
    if (onPace) {
      statusText = `On pace · ${pace}/day total, covering scope by exam`;
    } else {
      // "Behind on coverage" disambiguates: a high total/day with low
      // first-seen rate can leave coverage stuck even though the user is
      // grinding. The number to act on is whether NEW items are being
      // introduced fast enough — total work alone doesn't move coverage.
      statusText = `Behind on coverage · ${pace}/day total, projecting ${formatPercent(projectedPercent)}`;
      statusClass = 'text-[var(--md-error)]';
    }
  }

  // Secondary detail line: decompose the daily work so the user sees both
  // halves (new items + reviews) and the achievable daily target. This is
  // the place where "8 new + ~57 reviews" surfaces, instead of the
  // misleading floor-only "need 11/day".
  const detailFragments: string[] = [];
  if (projection.dailyTarget != null && projection.dailyTarget > 0) {
    detailFragments.push(`target ${projection.dailyTarget}/day`);
  }
  if (projection.recentNewPerDay > 0 || projection.recentTotalPerDay > 0) {
    const reviews = Math.max(0, projection.recentTotalPerDay - projection.recentNewPerDay);
    detailFragments.push(
      `${formatRate(projection.recentNewPerDay)} new + ${formatRate(reviews)} reviews`,
    );
  }
  if (projection.todayTotalItems > 0) {
    detailFragments.push(`${projection.todayTotalItems} today`);
  }

  return (
    <div className="space-y-2.5">
      {/* Coverage bar */}
      <div>
        <div
          className="relative h-2.5 w-full overflow-hidden rounded-full bg-[var(--md-surface-container-high)]"
          role="img"
          aria-label={
            noExam
              ? `Coverage: ${formatPercent(currentPercent)} covered`
              : `Coverage: ${formatPercent(currentPercent)} now, projected to ${formatPercent(projectedPercent)} by exam`
          }
        >
          {!noExam && projectedPercent > currentPercent && (
            <div
              className="absolute inset-y-0 left-0 bg-[var(--md-primary)] opacity-30"
              style={{ width: `${projectedPercent}%` }}
            />
          )}
          <div
            className="absolute inset-y-0 left-0 bg-[var(--md-primary)]"
            style={{ width: `${currentPercent}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-[var(--md-on-surface-variant)]">
          <span>covered {formatPercent(currentPercent)}</span>
          {!noExam && projectedPercent !== currentPercent && (
            <span>
              {projectedPercent >= 100
                ? 'finishing scope by exam'
                : `→ ${formatPercent(projectedPercent)} by exam`}
            </span>
          )}
        </div>
      </div>

      {/* Status line — total daily work, not just new-items floor */}
      <div className={`text-sm font-medium ${statusClass}`}>{statusText}</div>

      {/* Secondary breakdown — only when there's something to say */}
      {!noExam && detailFragments.length > 0 && (
        <div className="text-[11px] text-[var(--md-on-surface-variant)]">
          {detailFragments.join(' · ')}
        </div>
      )}

      {/* 14-day daily-activity sparkline */}
      {sparklineValues.length > 0 && <Sparkline values={sparklineValues} />}
    </div>
  );
}
