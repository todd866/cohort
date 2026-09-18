import { loadTopicHeatmap } from '@/lib/knowledge/topic-heat.server';
import { loadReviewCalendar } from '@/lib/knowledge/review-calendar.server';
import { loadLeaderboard } from '@/lib/leaderboard/leaderboard.server';
import { TopicHeatmap } from '@/components/profile/TopicHeatmap';
import { ProfileLeaderboard } from './profile-leaderboard';
import { ReadinessTrend } from '@/components/profile/ReadinessTrend';
import { ReviewHeatmap } from '@/components/profile/ReviewHeatmap';

/**
 * The two heavy sections of the profile, split out so the page does not wait
 * for them.
 *
 * Measured 2026-09-17: the profile awaited `loadTopicHeatmap` in the same
 * `Promise.all` as its cheap reads, and on a heavily-used account that call
 * took over ten seconds — so nothing on the page rendered, not the identity,
 * not the request box, not the links, until a sparkline finished computing.
 *
 * The cost is the readiness TREND, which cross-joins tens of thousands of
 * sample-card pairs against a long event history. Its own comment already called it
 * best-effort — "losing the trend costs a sparkline, never the grid" — which
 * was true of failure and not of latency: it could be skipped when it threw and
 * not when it was merely slow.
 *
 * Streaming is the right fix rather than a faster query, because this is
 * backwards-looking history aggregation and `.claude/rules/hot-path-latency.md`
 * puts that off the path a learner waits on. A faster version of this query
 * would still be work nobody should wait for before seeing their own name.
 *
 * Each section returns null on failure exactly as before, so a broken read
 * hides the grid rather than showing a wall of false grey.
 */

export async function ProfileReviewCalendarSection(
  { userId, rotations }: { userId: string; rotations: string[] },
) {
  const calendar = await loadReviewCalendar(userId, rotations).catch(() => null);
  if (!calendar) return null;
  return (
    <section aria-label="Review calendar" className="mb-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
        Reviews
      </h2>
      <ReviewHeatmap heatmap={calendar.heatmap} exams={calendar.exams} today={calendar.today} />
    </section>
  );
}

export async function ProfileTopicHeatmapSection({ userId }: { userId: string }) {
  const topicHeat = await loadTopicHeatmap(userId).catch(() => null);
  if (!topicHeat) return null;
  return (
    <section aria-label="Topic readiness" className="mb-6">
      <TopicHeatmap
        squares={topicHeat.squares}
        rotationLabel={topicHeat.rotationLabel}
        horizonDays={topicHeat.horizonDays}
        aside={
          <ReadinessTrend
            points={topicHeat.trend}
            projection={topicHeat.projection}
            totalTopics={topicHeat.squares.length}
            daysToExam={topicHeat.horizonDays}
          />
        }
      />
    </section>
  );
}

/**
 * The leaderboard, with its board already loaded when the learner is on it.
 * Streams like the heatmaps: it aggregates every joined learner's history,
 * which is page-render work and not something the first byte should wait on.
 * A failed read hands the client component no board, and it fetches as before.
 */
export async function ProfileLeaderboardSection(
  { userId, joined, handle }: { userId: string; joined: boolean; handle: string | null },
) {
  const board = joined && handle
    ? await loadLeaderboard(userId).then((b) => ({ handle, ...b })).catch(() => null)
    : null;
  return <ProfileLeaderboard joined={joined} handle={handle} initialBoard={board} />;
}

/**
 * Placeholders reserve the height their section will occupy.
 *
 * Not decoration: CLS is a budgeted metric here
 * (`.claude/rules/web-vitals.md`), and streaming a tall section into a page
 * that has already painted is precisely how a layout shift is earned. These
 * heights match the rendered sections — the review grid at roughly 7rem, the
 * topic grid plus its panel and trend at roughly 22rem stacked on a phone and
 * roughly 13rem once the panel sits beside the grid from `lg` up.
 */
export function ProfileSectionPlaceholder(
  { label, className }: { label: string; className: string },
) {
  return (
    <section aria-label={label} aria-busy="true" className={`mb-6 ${className}`}>
      <div className="h-full w-full rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]" />
    </section>
  );
}
