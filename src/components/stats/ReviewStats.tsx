import type {
  HeatmapCell,
  DayCount,
  ReviewSummary,
  MaturityBucket,
} from '@/lib/review-stats';

/**
 * Anki-style review statistics.
 *
 * Colour decisions, per the dataviz procedure:
 *  - The heatmap and the maturity bar both encode ORDERED MAGNITUDE, so both use
 *    a single-hue sequential ramp (light → dark). Not four unrelated hues.
 *  - Reviews-per-day is a SINGLE SERIES. Anki splits it green/red by outcome,
 *    but that pair validates at ΔE 6.0 (deutan) in light and FAILS three checks
 *    in dark — a red-green trap. Accuracy is a separate tile instead.
 *  - No dual axis. Anki overlays a cumulative line on a second y-scale; two
 *    scales on one plot is the single most common charting error.
 *
 * The ramp steps live in globals.css as --md-ramp-0..4 alongside the other
 * design tokens, so light and dark are SELECTED rather than auto-flipped and no
 * raw hex leaks into a component.
 */

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-9">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-[0.7rem] font-bold uppercase tracking-[0.14em] text-[var(--md-on-surface-variant)] whitespace-nowrap">
          {title}
        </h2>
        <span className="h-px flex-1 bg-[var(--md-outline-soft)]" aria-hidden />
      </div>
      {hint && <p className="mb-3 text-xs text-[var(--md-on-surface-variant)]">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function Tile({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-4">
      <p className="text-[1.6rem] leading-none font-bold tabular-nums text-[var(--md-on-surface)]">
        {value}
      </p>
      <p className="mt-1.5 text-xs font-medium text-[var(--md-on-surface)]">{label}</p>
      {sub && <p className="text-xs text-[var(--md-on-surface-variant)]">{sub}</p>}
    </div>
  );
}

const DOW = ['M', '', 'W', '', 'F', '', 'S'];

export function ReviewStats({
  summary,
  heatmap,
  daily,
  maturity,
  accuracyPct,
  reviewsDetached,
  periodLabel,
}: {
  summary: ReviewSummary;
  heatmap: HeatmapCell[];
  daily: DayCount[];
  maturity: MaturityBucket[];
  accuracyPct: number | null;
  reviewsDetached: number;
  periodLabel: string;
}) {
  const weeks = heatmap.length ? Math.max(...heatmap.map((c) => c.week)) + 1 : 0;
  const CELL = 11;
  const GAP = 2.5;

  const maxDaily = daily.reduce((m, d) => Math.max(m, d.count), 0) || 1;
  const maturityTotal = maturity.reduce((n, b) => n + b.count, 0) || 1;

  // Month labels above the heatmap — only where a month actually starts.
  const monthMarks: { week: number; label: string }[] = [];
  for (const c of heatmap) {
    if (c.date.slice(8) === '01') {
      const label = new Date(`${c.date}T00:00:00Z`).toLocaleDateString('en-AU', {
        month: 'short',
        timeZone: 'UTC',
      });
      if (!monthMarks.some((m) => m.week === c.week)) monthMarks.push({ week: c.week, label });
    }
  }

  return (
    <div>
      {/* Headline numbers — a stat row, not a chart */}
      <Section title="Reviews" hint={periodLabel}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile value={summary.totalReviews.toLocaleString()} label="Total reviews" />
          <Tile
            value={`${Math.round(summary.studiedFraction * 100)}%`}
            label="Days studied"
            sub={`${summary.daysStudied} of ${summary.daysInPeriod}`}
          />
          <Tile
            value={Math.round(summary.averagePerStudyDay).toLocaleString()}
            label="Per study day"
            sub={`${Math.round(summary.averagePerDay)}/day over period`}
          />
          <Tile
            value={String(summary.currentStreak)}
            label="Current streak"
            sub={`longest ${summary.longestStreak}`}
          />
        </div>
      </Section>

      {/* Calendar heatmap — sequential magnitude */}
      <Section title="Calendar" hint="Darker is a heavier day. Hover for the count.">
        <div className="overflow-x-auto pb-1">
          <div className="inline-block min-w-0">
            {monthMarks.length > 0 && (
              <svg
                width={weeks * (CELL + GAP) + 18}
                height={12}
                role="presentation"
                className="block"
              >
                {monthMarks.map((m) => (
                  <text
                    key={`${m.week}-${m.label}`}
                    x={18 + m.week * (CELL + GAP)}
                    y={9}
                    className="fill-[var(--md-on-surface-variant)]"
                    style={{ fontSize: 9 }}
                  >
                    {m.label}
                  </text>
                ))}
              </svg>
            )}
            <svg
              width={weeks * (CELL + GAP) + 18}
              height={7 * (CELL + GAP)}
              role="img"
              aria-label={`Review calendar: ${summary.totalReviews} reviews across ${summary.daysStudied} days`}
            >
              {DOW.map((d, i) =>
                d ? (
                  <text
                    key={i}
                    x={0}
                    y={i * (CELL + GAP) + CELL - 1}
                    className="fill-[var(--md-on-surface-variant)]"
                    style={{ fontSize: 8 }}
                  >
                    {d}
                  </text>
                ) : null,
              )}
              {heatmap.map((c) => (
                <rect
                  key={c.date}
                  x={18 + c.week * (CELL + GAP)}
                  y={c.weekday * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  fill={`var(--md-ramp-${c.level})`}
                >
                  <title>{`${c.date} · ${c.count} review${c.count === 1 ? '' : 's'}`}</title>
                </rect>
              ))}
            </svg>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-xs text-[var(--md-on-surface-variant)]">Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span
              key={l}
              className="inline-block h-2.5 w-2.5 rounded-[2px]"
              style={{ background: `var(--md-ramp-${l})` }}
              aria-hidden
            />
          ))}
          <span className="text-xs text-[var(--md-on-surface-variant)]">More</span>
        </div>
      </Section>

      {/* Reviews per day — SINGLE series, no dual axis */}
      <Section title="Reviews per day" hint="One bar per day. Hover for the exact count.">
        <div className="overflow-x-auto pb-1">
          <svg
            width={Math.max(daily.length * 4, 320)}
            height={110}
            role="img"
            aria-label={`Daily review counts, peak ${maxDaily}`}
            className="block"
          >
            {daily.map((d, i) => {
              const h = Math.max(1, Math.round((d.count / maxDaily) * 96));
              return (
                <rect
                  key={d.date}
                  x={i * 4}
                  y={104 - h}
                  width={2}
                  height={h}
                  rx={1}
                  fill="var(--md-ramp-4)"
                >
                  <title>{`${d.date} · ${d.count}`}</title>
                </rect>
              );
            })}
            <line
              x1={0}
              y1={104.5}
              x2={Math.max(daily.length * 4, 320)}
              y2={104.5}
              stroke="var(--md-outline-soft)"
              strokeWidth={1}
            />
          </svg>
        </div>
        {summary.busiestDay && (
          <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">
            Busiest day {summary.busiestDay.date} — {summary.busiestDay.count.toLocaleString()}{' '}
            reviews.
          </p>
        )}
      </Section>

      {/* Card maturity — ordered, so a sequential ramp */}
      <Section title="Card maturity" hint="Where your cards sit on the scheduler's stability scale.">
        <div className="flex h-7 w-full overflow-hidden rounded-lg" role="img" aria-label="Card maturity breakdown">
          {maturity.map((b) =>
            b.count === 0 ? null : (
              <div
                key={b.key}
                className="h-full"
                style={{
                  width: `${(b.count / maturityTotal) * 100}%`,
                  background: `var(--md-ramp-${b.step + 1})`,
                  // 2px surface gap between adjacent fills
                  borderRight: '2px solid var(--md-surface)',
                }}
                title={`${b.label}: ${b.count}`}
              />
            ),
          )}
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          {maturity.map((b) => (
            <li key={b.key} className="flex items-center gap-2 text-sm">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: `var(--md-ramp-${b.step + 1})` }}
                aria-hidden
              />
              <span className="text-[var(--md-on-surface)]">{b.label}</span>
              <span className="ml-auto tabular-nums text-[var(--md-on-surface-variant)]">
                {b.count.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
        {reviewsDetached > 0 && (
          <p className="mt-4 rounded-lg border border-[var(--md-outline-soft)] p-3 text-xs leading-relaxed text-[var(--md-on-surface-variant)]">
            <strong className="text-[var(--md-on-surface)]">
              {reviewsDetached.toLocaleString()} earlier reviews are not counted here.
            </strong>{' '}
            Card ids are regenerated when content is edited, so the progress behind
            them was orphaned and their stability restarted. That is why the bands
            above are compressed, and why no card has reached a long interval.
          </p>
        )}

        {accuracyPct !== null && (
          <p className="mt-4 text-sm text-[var(--md-on-surface)]">
            Overall accuracy{' '}
            <strong className="tabular-nums">{Math.round(accuracyPct)}%</strong>
            <span className="text-[var(--md-on-surface-variant)]">
              {' '}
              across all answered items.
            </span>
          </p>
        )}
      </Section>
    </div>
  );
}
