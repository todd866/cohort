import Link from 'next/link';
import { leaveByOptions, resolveDayEvents, sydneyNowTime, sydneyToday } from '@/lib/personal-brief';
import type { BriefEvent, CourseBrief, DayView, WbaView, WatchItem } from '@/lib/personal-brief';
import { buildReviewHref } from '@/lib/review/review-intent';

function fmt(iso: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Australia/Sydney',
  }).format(new Date(`${iso}T00:00:00Z`));
}

function UpcomingEventsSection({ brief, day }: { brief: CourseBrief; day: DayView }) {
  const upcoming = resolveDayEvents(brief, day.date, {
    afterTime: day.date === sydneyToday() ? sydneyNowTime() : undefined,
  });

  if (upcoming.length === 0) return null;

  return (
    <Section
      title="Timeline"
      subtitle="Duties, harvested one-shots, WBAs and deadlines for this day"
    >
      <ul className="space-y-2">
        {upcoming.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </ul>
    </Section>
  );
}

function EventRow({ event }: { event: BriefEvent }) {
  const when = event.when.time ?? event.when.timeLabel ?? event.when.date;
  const prepareHref = event.reviewIntent ? buildReviewHref(event.reviewIntent) : null;

  return (
    <li className="rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--md-on-surface-variant)]">
          {event.kind} · {when}
        </p>
        {prepareHref && event.kind !== 'action' ? (
          <Link href={prepareHref} className="text-xs font-medium text-[var(--md-primary)] hover:underline">
            Prepare →
          </Link>
        ) : null}
      </div>
      <p className="mt-0.5 text-sm font-semibold text-[var(--md-on-surface)]">{event.title}</p>
      {(event.where || event.leaveBy) && (
        <p className="mt-0.5 text-xs text-[var(--md-on-surface-variant)]">
          {[event.where, event.leaveBy ? `leave by ${event.leaveBy}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {event.prepTopics.length > 0 && (
        <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">
          Prep: {event.prepTopics.join(', ')}
        </p>
      )}
      {event.note ? (
        <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">{event.note}</p>
      ) : null}
    </li>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)] mb-1">
        {title}
      </h2>
      {subtitle && (
        <p className="text-xs text-[var(--md-on-surface-variant)] mb-3">{subtitle}</p>
      )}
      <div className={subtitle ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function Card({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'alert' | 'accent';
}) {
  const toneClass =
    tone === 'alert'
      ? 'border-[var(--md-error)] bg-[var(--md-error-container)]'
      : tone === 'accent'
        ? 'border-[var(--md-outline-soft)] bg-[var(--md-primary-container)]'
        : 'border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)]';
  return (
    <div className={`rounded-xl border p-4 ${toneClass}`}>{children}</div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] px-2.5 py-1 text-xs text-[var(--md-on-surface-variant)]">
      {children}
    </span>
  );
}

const URGENCY_LABEL: Record<WbaView['urgency'], string> = {
  overdue: 'Overdue',
  'due-soon': 'Due soon',
  upcoming: 'Upcoming',
  done: 'Done',
};

function WbaCard({ wba }: { wba: WbaView }) {
  const alert = wba.urgency === 'overdue' || wba.urgency === 'due-soon';
  return (
    <Card tone={alert ? 'alert' : 'neutral'}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold text-[var(--md-on-surface)]">
          WBA {wba.number} · {wba.title}
        </h3>
        <span className="shrink-0 text-xs font-medium text-[var(--md-on-surface-variant)]">
          {URGENCY_LABEL[wba.urgency]}
        </span>
      </div>

      <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
        Due {fmt(wba.dueDate)} {wba.dueTime} · week {wba.dueWeek} ·{' '}
        {wba.daysUntilDue >= 0 ? `${wba.daysUntilDue} days away` : `${-wba.daysUntilDue} days ago`}
      </p>

      {wba.dueConflict && (
        <p className="mt-2 rounded-lg border border-[var(--md-error)] p-2 text-xs text-[var(--md-on-surface)]">
          <strong>Date disputed.</strong> {wba.dueConflict.a.source} says{' '}
          {wba.dueConflict.a.value}; {wba.dueConflict.b.source} says {wba.dueConflict.b.value}.{' '}
          {wba.dueConflict.resolution}
        </p>
      )}

      {wba.note && (
        <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">{wba.note}</p>
      )}

      {wba.prepTopics.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium text-[var(--md-on-surface-variant)]">
            Know before you go
          </p>
          <div className="flex flex-wrap gap-1.5">
            {wba.prepTopics.map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
          </div>
        </div>
      )}

      {wba.prepResources.length > 0 && (
        <ul className="mt-3 space-y-1">
          {wba.prepResources.map((r) => (
            <li key={r.label}>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline text-[var(--md-primary)]"
              >
                {r.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function WatchRow({ w }: { w: WatchItem }) {
  return (
    <li className="border-b border-[var(--md-outline-soft)] py-2.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-[var(--md-on-surface)]">{w.item}</span>
        <span className="shrink-0 text-xs text-[var(--md-on-surface-variant)]">
          {w.status === 'action-required' ? 'Action needed' : 'Not published yet'}
        </span>
      </div>
      {w.note && (
        <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">{w.note}</p>
      )}
    </li>
  );
}

export function BriefView({ brief, day }: { brief: CourseBrief; day: DayView }) {
  const { block } = brief;
  const leaveBy = leaveByOptions(day.attachment, brief.commute);
  const actionNeeded = day.openWatchlist.filter((w) => w.status === 'action-required');
  const notPublished = day.openWatchlist.filter((w) => w.status === 'pending');
  const factsByTag = brief.arrivalFacts.reduce<Record<string, typeof brief.arrivalFacts>>(
    (acc, f) => {
      (acc[f.tag] ??= []).push(f);
      return acc;
    },
    {},
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-24 md:pb-6">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-wider text-[var(--md-on-surface-variant)]">
          What&apos;s next · {block.term}
        </p>
        <h1 className="text-2xl font-bold text-[var(--md-on-surface)]">{block.name}</h1>
        <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
          {block.site.name} ({block.site.shortName})
          {block.homeClinicalSchool ? ` · home school ${block.homeClinicalSchool}` : ''}
        </p>
      </header>

      {/* Today */}
      <Section title="Today">
        <Card tone="accent">
          {day.phase === 'before' && (
            <>
              <p className="text-lg font-semibold text-[var(--md-on-primary-container)]">
                {day.daysUntilStart} days until the block starts
              </p>
              <p className="mt-1 text-sm text-[var(--md-on-primary-container)]">
                Day 1 is {fmt(block.orientationDate)} — orientation, intro lecture and Basic Life
                Support at {block.site.shortName}.
              </p>
            </>
          )}

          {day.phase === 'during' && (
            <>
              <p className="text-lg font-semibold text-[var(--md-on-primary-container)]">
                {day.isOrientation
                  ? 'Orientation day'
                  : (day.attachment?.label ?? 'No clinical attachment today')}
              </p>
              <p className="mt-1 text-sm text-[var(--md-on-primary-container)]">
                {day.week ? `Week ${day.week.week}` : 'Between weeks'} · {block.site.shortName}
                {day.week?.note ? ` · ${day.week.note}` : ''}
              </p>
            </>
          )}

          {day.phase === 'after' && (
            <p className="text-lg font-semibold text-[var(--md-on-primary-container)]">
              Block complete.
            </p>
          )}
        </Card>

        {block.site.note && (
          <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">{block.site.note}</p>
        )}

        {block.site.wayfindingPages.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-3">
            {block.site.wayfindingPages.map((p) => (
              <a
                key={p.url}
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline text-[var(--md-primary)]"
              >
                {p.label}
              </a>
            ))}
          </div>
        )}
      </Section>

      <UpcomingEventsSection brief={brief} day={day} />

      {/* Needs action */}
      {actionNeeded.length > 0 && (
        <Section title="Needs action">
          <Card tone="alert">
            <ul>
              {actionNeeded.map((w) => (
                <WatchRow key={w.item} w={w} />
              ))}
            </ul>
          </Card>
        </Section>
      )}

      {/* Daily routine */}
      {day.attachment && (
        <Section
          title="Your day"
          subtitle={
            day.attachment.location
              ? `${day.attachment.label} — ${day.attachment.location}`
              : day.attachment.label
          }
        >
          {leaveBy.length > 0 && (
            <Card tone="neutral">
              <p className="mb-2 text-xs font-medium text-[var(--md-on-surface-variant)]">
                On the floor by {day.attachment.firstDayStart} → leave home by
              </p>
              <ul className="space-y-1">
                {leaveBy.map((o) => (
                  <li key={o.mode} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-[var(--md-on-surface)]">
                      <strong>{o.leaveBy}</strong>{' '}
                      <span className="text-[var(--md-on-surface-variant)]">
                        {o.mode.replace('-', ' ')}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-[var(--md-on-surface-variant)]">
                      {o.basisMinutes} min{o.optimistic ? ' · optimistic' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {day.attachment.dailyAnchors && day.attachment.dailyAnchors.length > 0 && (
            <ul className="mt-3">
              {day.attachment.dailyAnchors.map((a) => (
                <li
                  key={`${a.time}-${a.what}`}
                  className="flex gap-3 border-b border-[var(--md-outline-soft)] py-2 last:border-0"
                >
                  <span className="w-16 shrink-0 text-sm font-medium text-[var(--md-on-surface)]">
                    {a.time}
                  </span>
                  <span className="text-sm text-[var(--md-on-surface)]">
                    {a.what}
                    <span className="block text-xs text-[var(--md-on-surface-variant)]">
                      {a.where} · {a.days}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {day.attachment.weeklyFixtures && day.attachment.weeklyFixtures.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-medium text-[var(--md-on-surface-variant)]">
                Weekly fixtures
              </p>
              <ul className="space-y-1">
                {day.attachment.weeklyFixtures.map((f) => (
                  <li key={`${f.day}-${f.time}-${f.what}`} className="text-sm">
                    <span className="text-[var(--md-on-surface-variant)]">
                      {f.day} {f.time}
                    </span>{' '}
                    <span className="text-[var(--md-on-surface)]">{f.what}</span>
                    {f.where !== '—' && (
                      <span className="text-[var(--md-on-surface-variant)]"> · {f.where}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {day.attachment.note && (
            <p className="mt-3 text-xs text-[var(--md-on-surface-variant)]">
              {day.attachment.note}
            </p>
          )}

          {day.attachment.contacts && day.attachment.contacts.length > 0 && (
            <ul className="mt-3 space-y-0.5">
              {day.attachment.contacts.map((c) => (
                <li key={`${c.role}-${c.name}`} className="text-xs text-[var(--md-on-surface-variant)]">
                  {c.role}: <span className="text-[var(--md-on-surface)]">{c.name}</span>
                  {c.email && ` · ${c.email}`}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* Getting there */}
      {brief.commute && (
        <Section title="Getting there" subtitle={brief.commute.note}>
          <div className="space-y-3">
            {brief.commute.options.map((o) => (
              <Card key={o.mode}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-[var(--md-on-surface)]">
                    {o.mode.replace('-', ' ')}
                  </span>
                  <span className="shrink-0 text-sm text-[var(--md-on-surface-variant)]">
                    {o.minutesRealistic ? `${o.minutesRealistic} min` : `${o.minutes} min`}
                    {o.distanceKm ? ` · ${o.distanceKm} km` : ''}
                  </span>
                </div>
                {o.route ? (
                  <p className="mt-0.5 text-xs text-[var(--md-on-surface-variant)]">{o.route}</p>
                ) : null}
                {o.caveats.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {o.caveats.map((c) => (
                      <li key={c} className="text-xs text-[var(--md-on-surface-variant)]">
                        · {c}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
          </div>

          {brief.commute.costModel && (
            <Card tone="alert">
              <p className="text-lg font-semibold text-[var(--md-on-surface)]">
                {brief.commute.costModel.headline}
              </p>
              <ul className="mt-2">
                {brief.commute.costModel.lines.map((l) => (
                  <li
                    key={l.item}
                    className="border-b border-[var(--md-outline-soft)] py-2 last:border-0"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-[var(--md-on-surface)]">{l.item}</span>
                      <span className="shrink-0 text-sm font-medium text-[var(--md-on-surface)]">
                        {l.total === null
                          ? 'not priced'
                          : `$${l.total.toFixed(0)}`}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--md-on-surface-variant)]">
                      {l.unit !== null && `$${l.unit.toFixed(2)} × ${l.days} days · `}
                      {l.unitNote}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">
                {brief.commute.costModel.clinicalDaysBasis} {brief.commute.costModel.verified}
              </p>
            </Card>
          )}

          {brief.commute.parkingDecision && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-medium text-[var(--md-on-surface-variant)]">
                Parking: the actual choice
              </p>
              <ul className="space-y-2">
                {brief.commute.parkingDecision.options.map((o) => (
                  <li
                    key={o.id}
                    className="rounded-lg border border-[var(--md-outline-soft)] p-3"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium text-[var(--md-on-surface)]">
                        {o.label}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--md-on-surface-variant)]">
                        {o.blockCost === null
                          ? 'not priced'
                          : o.blockCost === 0
                            ? 'free'
                            : `$${o.blockCost} / block`}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">{o.verdict}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[var(--md-on-surface)]">
                <strong>Recommendation.</strong>{' '}
                {brief.commute.parkingDecision.recommendation}
              </p>
              <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">
                Fine assumed at ${brief.commute.parkingDecision.fineAmount}.{' '}
                {brief.commute.parkingDecision.fineConfidence}
              </p>
            </div>
          )}

          {brief.commute.cheaperOptions && brief.commute.cheaperOptions.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-medium text-[var(--md-on-surface-variant)]">
                Ways to spend less
              </p>
              <ul className="space-y-2">
                {brief.commute.cheaperOptions.map((c) => (
                  <li key={c.option} className="text-sm">
                    <span className="text-[var(--md-on-surface)]">{c.option}</span>
                    <span className="text-xs text-[var(--md-on-surface-variant)]">
                      {' '}
                      ({c.confidence})
                    </span>
                    <p className="text-xs text-[var(--md-on-surface-variant)]">{c.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {brief.commute.returnTrip && (
            <div className="mt-3 rounded-lg border border-[var(--md-outline-soft)] p-3">
              <p className="text-sm font-medium text-[var(--md-on-surface)]">
                {brief.commute.returnTrip.title}
              </p>
              <p className="mt-0.5 text-xs text-[var(--md-on-surface-variant)]">
                {brief.commute.returnTrip.detail}
              </p>
            </div>
          )}

          {brief.commute.openQuestions && brief.commute.openQuestions.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-[var(--md-on-surface-variant)]">
                Still unknown
              </p>
              <ul className="space-y-0.5">
                {brief.commute.openQuestions.map((q) => (
                  <li key={q} className="text-xs text-[var(--md-on-surface-variant)]">
                    · {q}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {/* WBAs */}
      {day.upcomingWbas.length > 0 && (
        <Section
          title="Workplace-based assessments"
          subtitle={brief.wbaRules?.missedDeadlineNote}
        >
          <div className="space-y-3">
            {day.upcomingWbas.map((w) => (
              <WbaCard key={w.id} wba={w} />
            ))}
          </div>
          {brief.wbaRules && (
            <p className="mt-3 text-xs text-[var(--md-on-surface-variant)]">
              {brief.wbaRules.assessorMinimum}
            </p>
          )}
        </Section>
      )}

      {/* This week's knowledge */}
      {(day.canvasTopics.length > 0 || day.reviewTopics.length > 0) && (
        <Section
          title="What you need to know"
          subtitle={
            day.week
              ? `Canvas expects these covered in week ${day.week.week}.`
              : undefined
          }
        >
          {day.canvasTopics.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {day.canvasTopics.map((t) => (
                <Chip key={t}>{t}</Chip>
              ))}
            </div>
          )}

          {day.md3Weeks.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {day.md3Weeks.map((w) => (
                <Link
                  key={w}
                  href={`/${block.rotationId}/week/${w}/review`}
                  className="rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] px-3 py-2 text-sm text-[var(--md-on-surface)]"
                >
                  Review md3 week {w} →
                </Link>
              ))}
            </div>
          )}

          {day.reviewTopics.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-medium text-[var(--md-on-surface-variant)]">
                Relevant to {day.attachment?.label}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {day.reviewTopics.map((t) => (
                  <Chip key={t}>{t}</Chip>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* Attachments */}
      <Section title="Attachments">
        <ul className="space-y-2">
          {brief.attachments.map((a) => {
            const current = day.attachment?.label === a.label;
            return (
              <li
                key={a.label}
                className={`rounded-lg border p-3 ${
                  current
                    ? 'border-[var(--md-primary)] bg-[var(--md-primary-container)]'
                    : 'border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)]'
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-[var(--md-on-surface)]">{a.label}</span>
                  <span className="shrink-0 text-xs text-[var(--md-on-surface-variant)]">
                    weeks {a.weeks.join(' & ')}
                  </span>
                </div>
                <p className="text-xs text-[var(--md-on-surface-variant)]">
                  {fmt(a.startDate)} – {fmt(a.endDate)}
                </p>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* Deadlines */}
      {day.upcomingDeadlines.length > 0 && (
        <Section title="Deadlines">
          <ul>
            {day.upcomingDeadlines.map((d) => (
              <li
                key={`${d.title}-${d.dueDate}`}
                className="flex items-baseline justify-between gap-3 border-b border-[var(--md-outline-soft)] py-2.5 last:border-0"
              >
                <div>
                  <p className="text-sm text-[var(--md-on-surface)]">{d.title}</p>
                  <p className="text-xs text-[var(--md-on-surface-variant)]">{d.where}</p>
                </div>
                <span className="shrink-0 text-xs text-[var(--md-on-surface-variant)]">
                  {fmt(d.dueDate)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Arrival facts */}
      {brief.arrivalFacts.length > 0 ? (
        <Section title="On arrival">
          <div className="space-y-4">
            {Object.entries(factsByTag).map(([tag, facts]) => (
              <div key={tag}>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--md-on-surface-variant)]">
                  {tag}
                </p>
                <ul className="space-y-1.5">
                  {facts.map((f) => (
                    <li key={f.title} className="text-sm text-[var(--md-on-surface)]">
                      <span className="font-medium">{f.title}.</span>{' '}
                      <span className="text-[var(--md-on-surface-variant)]">{f.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Where things are */}
      {brief.campusLocations && brief.campusLocations.length > 0 && (
        <Section title="Where things are" subtitle={`Inside ${block.site.shortName}`}>
          <ul>
            {brief.campusLocations.map((l) => (
              <li
                key={l.name}
                className="border-b border-[var(--md-outline-soft)] py-2.5 last:border-0"
              >
                <p className="text-sm font-medium text-[var(--md-on-surface)]">
                  {l.name}
                  {l.phone && (
                    <span className="font-normal text-[var(--md-on-surface-variant)]">
                      {' '}
                      · {l.phone}
                    </span>
                  )}
                </p>
                <p className="text-xs text-[var(--md-on-surface-variant)]">{l.where}</p>
                <p className="text-xs text-[var(--md-on-surface-variant)]">{l.usedFor}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Not published yet */}
      {notPublished.length > 0 && (
        <Section
          title="Not published yet"
          subtitle="Tracked so it can't quietly slip. The morning check watches for each of these."
        >
          <ul>
            {notPublished.map((w) => (
              <WatchRow key={w.item} w={w} />
            ))}
          </ul>
        </Section>
      )}

      {/* Contacts */}
      {block.contacts.length > 0 ? (
        <Section title="Contacts">
          <ul className="space-y-1.5">
            {block.contacts.map((c) => (
              <li key={c.email} className="text-sm">
                <span className="text-[var(--md-on-surface)]">{c.name}</span>{' '}
                <span className="text-[var(--md-on-surface-variant)]">— {c.role}</span>
                <br />
                <a href={`mailto:${c.email}`} className="text-xs underline text-[var(--md-primary)]">
                  {c.email}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <footer className="mt-10 border-t border-[var(--md-outline-soft)] pt-4">
        <p className="text-xs text-[var(--md-on-surface-variant)]">
          Last refreshed {fmt(brief.updatedAt)}
          {brief.sources.length > 0
            ? ` from ${brief.sources.map((s) => s.label).join(', ')}`
            : ''}.
        </p>
      </footer>
    </div>
  );
}
