/**
 * Estimated total knowledge: one number, and a sparkline when a series exists.
 * The same reading on the profile and in the retrievability section.
 */
import { knowledgeSparkline } from '@/lib/stats/stats-model';

export const ESTIMATED_KNOWLEDGE_HINT =
  'Sum of current retrievability over scheduled cards. Each decile counts as its midpoint.';

export function formatEstimatedKnowledge(cards: number | null): string {
  if (cards == null || !Number.isFinite(cards)) return '–';
  return `≈ ${Math.round(cards).toLocaleString('en-AU')}`;
}

export function EstimatedKnowledge({
  cards,
  trend,
  framed = false,
}: {
  cards: number | null;
  trend: readonly number[] | null;
  framed?: boolean;
}) {
  const points = knowledgeSparkline(trend);
  return (
    <section
      aria-label="Estimated total knowledge"
      title={ESTIMATED_KNOWLEDGE_HINT}
      className={framed
        ? 'flex min-h-[4.5rem] min-w-0 items-center gap-3 rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] px-3 py-3'
        : 'mb-2 flex min-w-0 items-center gap-3'}
    >
      <p className="whitespace-nowrap text-[2rem] font-semibold leading-none tabular-nums text-[var(--md-on-surface)]">
        {formatEstimatedKnowledge(cards)}
      </p>
      <p className="min-w-0 text-xs leading-snug text-[var(--md-on-surface-variant)]">cards you&apos;d recall today</p>
      {points ? <span className="ml-auto shrink-0"><KnowledgeSparkline values={points} /></span> : null}
    </section>
  );
}

function KnowledgeSparkline({ values }: { values: readonly number[] }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 72;
  const height = 32;
  const path = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 1 - ((value - min) / span) * (height - 2);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-8 w-[4.5rem] shrink-0" role="img" aria-label="30-day estimated knowledge">
      <title>30-day estimated knowledge</title>
      <path d={path} fill="none" stroke="var(--md-ramp-4)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
