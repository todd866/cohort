import Link from 'next/link';
import { ReviewHeatmap } from '@/components/profile/ReviewHeatmap';
import { assembleExamMarkers } from '@/lib/stats/calendar-grid';
import type { StatsPagePayload } from '@/lib/stats/stats-page.server';
import { estimatedKnowledgeFromHistogram, formatCivilDate, meanRetrievability, PERIOD_LABELS, SPACED_REVIEW_DEFINITION, STATS_PERIODS, type StatsPeriod } from '@/lib/stats/stats-model';
import type { StatsSectionId } from '@/lib/stats/stats-layout';
import type { StatsSurfaces } from '@/lib/stats/stats-surfaces';
import { StatsLayoutShell } from './StatsLayoutShell';
import { AreaGapChart } from './AreaGapChart';
import {
  AxisEnds,
  Bars,
  ButtonsInstrument,
  CardCountsInstrument,
  ForecastInstrument,
  HourlyInstrument,
  Instrument,
  KindsInstrument,
  MemoryInstrument,
  PracticeInstrument,
  Readouts,
  RetentionInstrument,
  rotationShort,
  StagesInstrument,
  TodayReadout,
  fmtInt,
} from './StatsInstruments';

function href(basePath: string, period: StatsPeriod, rotation: string | null): string {
  const params = new URLSearchParams();
  if (period !== '30d') params.set('period', period);
  if (rotation) params.set('rotation', rotation);
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function Segmented({ label, items }: { label: string; items: Array<{ key: string; text: string; href: string; active: boolean }> }) {
  return (
    <nav aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-[var(--md-outline-soft)] text-sm">
      {items.map((item) => (
        <Link key={item.key} href={item.href} prefetch={false} aria-current={item.active ? 'true' : undefined}
          className={`inline-flex min-h-9 items-center px-2.5 tabular-nums ${item.active ? 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container)]'}`}>
          {item.text}
        </Link>
      ))}
    </nav>
  );
}

export function StatsDashboard({ data, surfaces, basePath = '/profile/stats' }: { data: StatsPagePayload; surfaces: StatsSurfaces; basePath?: string }) {
  const periodWord = PERIOD_LABELS[data.period];
  const s = data.periodSummary;
  const toolbar = (
    <>
      <Segmented label="Period" items={STATS_PERIODS.map((p) => ({
        key: p, text: PERIOD_LABELS[p], href: href(basePath, p, data.rotation), active: p === data.period,
      }))} />
      {data.rotations.length > 1 && (
        <Segmented label="Rotation" items={[
          { key: 'all', text: 'All', href: href(basePath, data.period, null), active: data.rotation === null },
          ...data.rotations.slice(0, 6).map((r) => ({ key: r, text: rotationShort(r), href: href(basePath, data.period, r), active: data.rotation === r })),
        ]} />
      )}
    </>
  );

  const sections: Partial<Record<StatsSectionId, React.ReactNode>> = {
    today: (
      <Instrument title="Today" aside={formatCivilDate(data.today, data.today)}>
        <TodayReadout today={data.todaySummary} />
      </Instrument>
    ),
    forecast: (
      <Instrument title="Due forecast">
        <ForecastInstrument forecast={data.forecast} load={data.dailyLoad} />
      </Instrument>
    ),
    calendar: (
      <Instrument title="Calendar">
        <ReviewHeatmap
          heatmap={data.heatmap}
          today={data.today}
          blocks={data.calendarBlocks}
          zoom={data.layout.zoom}
          layout={data.layout}
          exams={assembleExamMarkers({
            today: data.today,
            results: data.exams.map((exam) => ({ date: exam.examDate, rotation: exam.rotation, score: exam.score, resultId: exam.id })),
            scheduled: data.calendarBlocks.filter((block) => block.rotation).map((block) => ({ date: block.exam, rotation: block.rotation as string })),
          })}
        />
      </Instrument>
    ),
    daily: (
      <Instrument title="Reviews per day" aside={periodWord}>
        <Readouts cells={[
          { value: fmtInt(s.totalReviews), label: 'reviews' },
          { value: `${s.daysStudied}/${s.daysInPeriod}`, label: 'days studied' },
          { value: fmtInt(Math.round(s.averagePerStudyDay)), label: 'per study day' },
          { value: fmtInt(Math.round(s.averagePerDay)), label: 'per day' },
          { value: String(s.currentStreak), label: 'streak' },
          { value: String(s.longestStreak), label: 'longest' },
        ]} />
        <div className="mt-3">
          <Bars values={data.daily.map((d) => d.count)} titles={data.daily.map((d) => `${formatCivilDate(d.date, data.today)} · ${d.count}`)} label="Reviews per day" />
          <AxisEnds left={formatCivilDate(data.daily[0]?.date ?? data.today, data.today)} right={formatCivilDate(data.daily[data.daily.length - 1]?.date ?? data.today, data.today)} />
        </div>
      </Instrument>
    ),
    time: (
      <Instrument title="Review time" aside={periodWord} hint="Answer time per day, each answer capped at 60 s">
        <Bars
          values={data.reviewMinutes.map((day) => day.minutes)}
          titles={data.reviewMinutes.map((day) => `${formatCivilDate(day.date, data.today)} · ${day.minutes < 10 ? Math.round(day.minutes * 10) / 10 : Math.round(day.minutes)} min`)}
          label="Minutes per day"
        />
        <AxisEnds left={formatCivilDate(data.reviewMinutes[0]?.date ?? data.today, data.today)} right={formatCivilDate(data.reviewMinutes[data.reviewMinutes.length - 1]?.date ?? data.today, data.today)} />
      </Instrument>
    ),
    stages: (
      <Instrument title="Reviews by stage" aside={periodWord}>
        <StagesInstrument stages={data.stages} />
      </Instrument>
    ),
    counts: (
      <Instrument title="Card counts">
        <CardCountsInstrument counts={data.cardCounts} />
      </Instrument>
    ),
    memory: (
      <Instrument title="Intervals and memory">
        <MemoryInstrument intervals={data.intervals} stability={data.stability} retrievability={data.retrievability}
          meanR={meanRetrievability(data.retrievability)}
          knowledge={estimatedKnowledgeFromHistogram(data.retrievability)} />
      </Instrument>
    ),
    retention: (
      <Instrument title="Spaced-review pass rate" hint={SPACED_REVIEW_DEFINITION}>
        <RetentionInstrument rows={data.retention} />
      </Instrument>
    ),
    hourly: (
      <Instrument title="Hour of day" aside={periodWord}>
        <HourlyInstrument hours={data.hourly} />
      </Instrument>
    ),
    buttons: (
      <Instrument title="Answer buttons" aside={periodWord}>
        <ButtonsInstrument rows={data.buttons} />
      </Instrument>
    ),
    kinds: (
      <Instrument title="Cloze vs MCQ">
        <KindsInstrument rows={data.kinds} />
      </Instrument>
    ),
    areas: (
      <Instrument title="Blueprint areas" aside={surfaces.examGapsHref ? <Link href={surfaces.examGapsHref} className="hover:underline">Exams →</Link> : undefined}>
        <AreaGapChart key={data.rotation ?? 'all'} tables={data.areaTables} exams={data.exams} rotations={data.areaRotations} current={data.rotation} />
      </Instrument>
    ),
    practice: (
      <Instrument title="Practice papers">
        <PracticeInstrument rows={data.practice} today={data.today} />
      </Instrument>
    ),
  };

  return <StatsLayoutShell initial={data.layout} sections={sections} toolbar={toolbar} layoutEndpoint={surfaces.layoutEndpoint} />;
}
