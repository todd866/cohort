import {
  describeProjection,
  type ReadinessPoint,
  type ReadinessProjection,
} from '@/lib/knowledge/readiness-trend';

/**
 * Where readiness has been going, and where it lands on exam day.
 *
 * Sits under the topic grid and answers the question the grid cannot: the grid
 * says how many topics are ready today, this says whether that number is
 * rising fast enough to matter.
 *
 * A single line with a dashed projection to the exam, drawn against the full
 * topic count so the gap to "all green" is the visible thing rather than an
 * autoscaled wiggle. Autoscaling a progress chart to its own range is the
 * classic way to make 3 topics of movement look like triumph.
 */

const WIDTH = 260;
const HEIGHT = 56;
const PAD = 3;
/** Room at the right for the endpoint and target labels. */
const LABEL_GUTTER = 30;

export function ReadinessTrend({
  points,
  projection,
  totalTopics,
  daysToExam,
}: {
  points: ReadinessPoint[];
  projection: ReadinessProjection | null;
  totalTopics: number;
  daysToExam: number;
}) {
  if (points.length < 2 || totalTopics <= 0) return null;

  const firstMs = Date.parse(`${points[0].date}T00:00:00Z`);
  const lastMs = Date.parse(`${points[points.length - 1].date}T00:00:00Z`);
  if (Number.isNaN(firstMs) || Number.isNaN(lastMs) || lastMs <= firstMs) return null;

  // The x-axis spans history AND the run-up to the exam, so the dashed segment
  // is drawn to scale rather than as a decorative stub.
  const examMs = lastMs + Math.max(0, daysToExam) * 86_400_000;
  const spanMs = examMs - firstMs || 1;
  const x = (ms: number) =>
    PAD + ((ms - firstMs) / spanMs) * (WIDTH - PAD * 2 - LABEL_GUTTER);
  const y = (ready: number) =>
    HEIGHT - PAD - (Math.max(0, Math.min(totalTopics, ready)) / totalTopics) * (HEIGHT - PAD * 2);

  const last = points[points.length - 1];

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(Date.parse(`${p.date}T00:00:00Z`)).toFixed(1)} ${y(p.ready).toFixed(1)}`)
    .join(' ');
  const projectedPath = projection?.confidentEnough
    ? `M ${x(lastMs).toFixed(1)} ${y(last.ready).toFixed(1)} L ${x(examMs).toFixed(1)} ${y(projection.projectedReady).toFixed(1)}`
    : null;

  const sentence = projection
    ? describeProjection({ projection, totalTopics, daysToExam })
    : null;

  return (
    <div className="mt-3">
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block max-w-full"
        role="img"
        aria-label={
          sentence
            ? `Topics ready over time. ${sentence}`
            : `Topics ready over time: ${last.ready} of ${totalTopics}.`
        }
      >
        {/* The target: every topic ready. */}
        <line
          x1={PAD}
          y1={y(totalTopics)}
          x2={WIDTH - PAD - LABEL_GUTTER}
          y2={y(totalTopics)}
          stroke="var(--md-outline-soft)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {/* Label both ends of the scale, so a nearly-flat line is still
            readable as "107 of 129" rather than as a flat line. */}
        <text
          x={WIDTH - PAD - LABEL_GUTTER + 4}
          y={y(totalTopics) + 3}
          className="fill-[var(--md-on-surface-variant)]"
          style={{ fontSize: 9 }}
        >
          {totalTopics}
        </text>
        <text
          x={WIDTH - PAD - LABEL_GUTTER + 4}
          y={Math.min(HEIGHT - PAD, Math.max(y(last.ready) + 3, y(totalTopics) + 13))}
          className="fill-[var(--md-heat-4)]"
          style={{ fontSize: 9, fontWeight: 600 }}
        >
          {last.ready}
        </text>
        <path d={path} fill="none" stroke="var(--md-heat-3)" strokeWidth={1.75} />
        {projectedPath && (
          <path
            d={projectedPath}
            fill="none"
            stroke="var(--md-on-surface-variant)"
            strokeWidth={1.25}
            strokeDasharray="3 3"
            opacity={0.8}
          />
        )}
        <circle cx={x(lastMs)} cy={y(last.ready)} r={2.25} fill="var(--md-heat-4)" />
      </svg>

      {sentence && (
        <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">{sentence}</p>
      )}
    </div>
  );
}
