import Link from 'next/link';
import { buildReviewHref } from '@/lib/review/review-intent';
import type { BriefEvent } from '@/lib/personal-brief';
import { SUPPORTS_PERSONAL_BRIEF } from '@/lib/institution';

function formatWhen(event: BriefEvent): string {
  const { date, time, timeLabel } = event.when;
  if (time || timeLabel) return `${date} · ${time ?? timeLabel}`;
  return date;
}

/**
 * Profile hub block under Statistics — next timed event + Prepare + dossier link.
 */
export function WhatsNextSection({
  next,
  upcoming,
}: {
  next: BriefEvent | null;
  upcoming: BriefEvent[];
}) {
  if (!SUPPORTS_PERSONAL_BRIEF) return null;

  const prepareHref = next?.reviewIntent
    ? buildReviewHref(next.reviewIntent)
    : null;

  const preview = upcoming.filter((e) => e.id !== next?.id).slice(0, 3);

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
          What&apos;s next
        </h2>
        <Link
          href="/brief"
          className="text-xs font-medium text-[var(--md-on-surface-variant)] hover:underline"
        >
          Full dossier →
        </Link>
      </div>

      {!next ? (
        <div className="rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] px-4 py-3">
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            Nothing scheduled for today. Check the dossier for WBAs and watchlist.
          </p>
          <Link
            href="/brief"
            className="mt-2 inline-block text-sm font-medium text-[var(--md-on-surface)] hover:underline"
          >
            Open What&apos;s next →
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] px-4 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--md-on-surface-variant)]">
            {next.kind}
          </p>
          <h3 className="mt-1 text-base font-semibold text-[var(--md-on-surface)]">{next.title}</h3>
          <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
            {formatWhen(next)}
            {next.where ? ` · ${next.where}` : ''}
            {next.leaveBy ? ` · leave by ${next.leaveBy}` : ''}
          </p>
          {next.prepTopics.length > 0 && (
            <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">
              Prep: {next.prepTopics.join(', ')}
            </p>
          )}
          {next.note ? (
            <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">{next.note}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {prepareHref ? (
              <Link
                href={prepareHref}
                className="inline-flex min-h-11 items-center rounded-lg bg-[var(--md-primary)] px-4 text-sm font-medium text-[var(--md-on-primary)]"
              >
                Prepare
              </Link>
            ) : null}
            <Link
              href="/brief"
              className="inline-flex min-h-11 items-center rounded-lg border border-[var(--md-outline)] px-4 text-sm font-medium text-[var(--md-on-surface)]"
            >
              Details
            </Link>
          </div>
        </div>
      )}

      {preview.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {preview.map((e) => (
            <li
              key={e.id}
              className="text-xs text-[var(--md-on-surface-variant)]"
            >
              <span className="font-medium text-[var(--md-on-surface)]">{formatWhen(e)}</span>
              {' · '}
              {e.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
