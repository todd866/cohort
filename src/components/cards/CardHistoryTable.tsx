/**
 * The signed-in learner's reviews of this card. Column headers name the
 * numbers. Nothing when this learner has not reviewed it.
 */
import {
  formatHistoryDate,
  formatIntervalDays,
  formatResponseSeconds,
  type CardHistoryRow,
} from '@/lib/stats/card-history';

const GRADE_TONE: Record<string, string> = {
  Again: 'text-[var(--md-error)]',
  Hard: 'text-[var(--md-warning)]',
  Good: 'text-[var(--md-success)]',
  Easy: 'text-[var(--md-primary)]',
};

export function CardHistoryTable({ rows }: { rows: readonly CardHistoryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Your reviews" className="mb-6">
      <table className="w-full table-fixed text-sm">
        <caption className="sr-only">Your reviews of this card</caption>
        <thead>
          <tr className="text-left text-[0.7rem] text-[var(--md-on-surface-variant)]">
            <th className="w-[34%] py-1 font-medium">Date</th>
            <th className="w-[24%] py-1 font-medium">Grade</th>
            <th className="w-[18%] py-1 text-right font-medium">Time</th>
            <th className="w-[24%] py-1 text-right font-medium">Interval</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-[var(--md-outline-soft)]">
              <td className="truncate py-1.5 tabular-nums text-[var(--md-on-surface)]" title={row.date}>
                {formatHistoryDate(row.date)}
              </td>
              <td className={`truncate py-1.5 ${GRADE_TONE[row.grade] ?? 'text-[var(--md-on-surface)]'}`}>{row.grade}</td>
              <td className="py-1.5 text-right tabular-nums text-[var(--md-on-surface)]" title="Answer time, capped at 60 s">
                {formatResponseSeconds(row.responseSeconds)}
              </td>
              <td className="py-1.5 text-right tabular-nums text-[var(--md-on-surface)]" title="Since the previous review">
                {formatIntervalDays(row.intervalDays)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
