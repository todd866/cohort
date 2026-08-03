import Link from 'next/link';
import type { HeatmapCell, ReviewSummary } from '@/lib/review-stats';

const DOW = ['M', '', 'W', '', 'F', '', 'S'];
const CELL = 10;
const GAP = 2;

/**
 * Compact motivating lead for Profile: totals + GitHub-style heatmap.
 * Full charts stay on /profile/stats.
 */
export function ReviewStatsLead({
  summary,
  heatmap,
  periodLabel,
}: {
  summary: ReviewSummary;
  heatmap: HeatmapCell[];
  periodLabel: string;
}) {
  const weeks = heatmap.length ? Math.max(...heatmap.map((c) => c.week)) + 1 : 0;

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
          Statistics
        </h2>
        <Link
          href="/profile/stats"
          className="text-xs font-medium text-[var(--md-on-surface-variant)] hover:underline"
        >
          Full stats →
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <LeadTile value={summary.totalReviews.toLocaleString()} label="Total reviews" />
        <LeadTile
          value={`${Math.round(summary.studiedFraction * 100)}%`}
          label="Days studied"
          sub={`${summary.daysStudied}/${summary.daysInPeriod}`}
        />
        <LeadTile
          value={Math.round(summary.averagePerStudyDay).toLocaleString()}
          label="Per study day"
        />
        <LeadTile
          value={String(summary.currentStreak)}
          label="Streak"
          sub={`best ${summary.longestStreak}`}
        />
      </div>

      {weeks > 0 && (
        <div className="mt-4 overflow-x-auto pb-1">
          <p className="mb-2 text-xs text-[var(--md-on-surface-variant)]">{periodLabel}</p>
          <svg
            width={weeks * (CELL + GAP) + 16}
            height={7 * (CELL + GAP)}
            role="img"
            aria-label={`Review calendar: ${summary.totalReviews} reviews`}
            className="block"
          >
            {DOW.map((d, i) =>
              d ? (
                <text
                  key={i}
                  x={0}
                  y={i * (CELL + GAP) + CELL - 1}
                  className="fill-[var(--md-on-surface-variant)]"
                  style={{ fontSize: 7 }}
                >
                  {d}
                </text>
              ) : null,
            )}
            {heatmap.map((c) => (
              <rect
                key={c.date}
                x={16 + c.week * (CELL + GAP)}
                y={c.weekday * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={2}
                fill={`var(--md-ramp-${c.level})`}
              >
                <title>{`${c.date} · ${c.count}`}</title>
              </rect>
            ))}
          </svg>
        </div>
      )}
    </section>
  );
}

function LeadTile({
  value,
  label,
  sub,
}: {
  value: string;
  label: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] px-3 py-3">
      <p className="text-xl font-bold tabular-nums leading-none text-[var(--md-on-surface)]">
        {value}
      </p>
      <p className="mt-1 text-xs font-medium text-[var(--md-on-surface)]">{label}</p>
      {sub && <p className="text-xs text-[var(--md-on-surface-variant)]">{sub}</p>}
    </div>
  );
}
