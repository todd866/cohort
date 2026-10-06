import { loadTopicHeatmap } from '@/lib/knowledge/topic-heat.server';
import { loadReviewCalendar } from '@/lib/knowledge/review-calendar.server';
import { loadLeaderboard } from '@/lib/leaderboard/leaderboard.server';
import { TopicHeatmap } from '@/components/profile/TopicHeatmap';
import { ProfileLeaderboard, type BoardResponse } from './profile-leaderboard';
import { ReadinessTrend } from '@/components/profile/ReadinessTrend';
import { ReviewHeatmap } from '@/components/profile/ReviewHeatmap';
import { ProfileReservedSlot } from './profile-reserved-slot';
import {
  REVIEW_CALENDAR_SLOT_CLASS,
  TOPIC_READINESS_SLOT_CLASS,
} from './profile-slot-classes';

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
 * A failed or empty read keeps the reserved height. Returning null under the
 * placeholder collapses the slot and shifts the rest of the page.
 */

const COULD_NOT_LOAD = "Couldn't load";

export async function ProfileReviewCalendarSection(
  { userId, rotations }: { userId: string; rotations: string[] },
) {
  const calendar = await loadReviewCalendar(userId, rotations).then(
    (value) => ({ value, failed: false }),
    () => ({ value: null, failed: true }),
  );
  if (calendar.failed) {
    return (
      <ProfileReservedSlot
        label="Review calendar"
        className={REVIEW_CALENDAR_SLOT_CLASS}
        message={COULD_NOT_LOAD}
      />
    );
  }
  if (!calendar.value) {
    return <ProfileReservedSlot label="Review calendar" className={REVIEW_CALENDAR_SLOT_CLASS} />;
  }
  const data = calendar.value;
  return (
    <section aria-label="Review calendar" className="mb-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
        Reviews
      </h2>
      <ReviewHeatmap heatmap={data.heatmap} exams={data.exams} today={data.today} />
    </section>
  );
}

export async function ProfileTopicHeatmapSection({ userId }: { userId: string }) {
  const topicHeat = await loadTopicHeatmap(userId).then(
    (value) => ({ value, failed: false }),
    () => ({ value: null, failed: true }),
  );
  if (topicHeat.failed) {
    return (
      <ProfileReservedSlot
        label="Topic readiness"
        className={TOPIC_READINESS_SLOT_CLASS}
        message={COULD_NOT_LOAD}
      />
    );
  }
  if (!topicHeat.value) {
    return <ProfileReservedSlot label="Topic readiness" className={TOPIC_READINESS_SLOT_CLASS} />;
  }
  const data = topicHeat.value;
  return (
    <section id="topic-readiness" aria-label="Topic readiness" className="mb-6 scroll-mt-4">
      <TopicHeatmap
        squares={data.squares}
        rotationLabel={data.rotationLabel}
        horizonDays={data.horizonDays}
        aside={
          <ReadinessTrend
            points={data.trend}
            projection={data.projection}
            totalTopics={data.squares.length}
            daysToExam={data.horizonDays}
          />
        }
      />
    </section>
  );
}

/**
 * The leaderboard, with its board already loaded when the learner is on it
 * (or, for an admin, whenever they open the profile).
 * Streams like the heatmaps: it aggregates every joined learner's history,
 * which is page-render work and not something the first byte should wait on.
 * The client does not fetch on mount. A failed read says so in the reserved
 * slot instead of handing over null and letting the browser paint the board twice.
 */
export async function ProfileLeaderboardSection(
  { userId, joined, handle, viewAll = false }:
  { userId: string; joined: boolean; handle: string | null; viewAll?: boolean },
) {
  // An admin sees the board whether or not they have joined: the everyone view
  // is how the owner reads the cohort, and it must not depend on opting in.
  if (!(viewAll || joined)) {
    return <ProfileLeaderboard joined={joined} handle={handle} viewAll={viewAll} initialBoard={null} />;
  }
  let initialBoard: BoardResponse | null = null;
  let boardUnavailable = false;
  try {
    const board = await loadLeaderboard(userId, new Date(), { includeEveryone: viewAll });
    initialBoard = { handle, ...board };
  } catch {
    boardUnavailable = true;
  }
  return (
    <ProfileLeaderboard
      joined={joined}
      handle={handle}
      viewAll={viewAll}
      initialBoard={initialBoard}
      boardUnavailable={boardUnavailable}
    />
  );
}
