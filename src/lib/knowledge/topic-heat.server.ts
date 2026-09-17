/**
 * Topic heat — the Prisma side.
 *
 * BACKGROUND / PAGE-RENDER USE ONLY — never import from the session serve
 * path. Like the currency board it replaced, this aggregates a learner's
 * backwards-looking review history, which is exactly the class of query
 * .claude/rules/hot-path-latency.md keeps off the request path. The sanctioned
 * caller is the profile page render; it is listed in BACKGROUND_ONLY_MODULES
 * in scripts/ops/check-hot-path-history.ts so any serve-path import fails the
 * lint.
 *
 * ONE grouped query for the whole grid. A rotation runs from a few thousand
 * cards to tens of thousands, so the weighting and the freshness test happen in
 * Postgres and only one row per cluster crosses the wire. The weights and window come from topic-heat.ts as bound parameters
 * rather than being re-spelled in SQL, so there is still exactly one place
 * where "hard counts double" is written down.
 *
 * Clusters cover CARDS only — `Question` has no clusterId, and assigning one
 * means an embedding backfill, not a column. So a square counts the cards in
 * its cluster, and clicking it serves those same cards. The number and the
 * action agree, which matters more here than padding the grid with MCQs that
 * a fuzzy topic-overlap join might or might not have got right.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  getCurrentRotation,
  getExamDateForUser,
  getRotation,
  isSelfPacedExamDate,
} from '@/lib/rotations';
import { tidyClusterLabel } from './cluster-label';
import { authoredClusterName } from './cluster-name-overlay';
import {
  projectReadiness,
  type ReadinessPoint,
  type ReadinessProjection,
} from './readiness-trend';
import {
  DAY_MS,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_STABILITY_DAYS,
  DIFFICULTY_WEIGHT,
  MIN_STABILITY_DAYS,
  WARM_CEILING,
  classifyTopicHeat,
  type TopicHeat,
} from './topic-heat';
export interface TopicSquare extends TopicHeat {
  /** Cluster id. */
  id: string;
  label: string;
  /** A few real card fronts, so the detail panel can say what the topic IS. */
  sampleFronts: string[];
  /** Where clicking the square sends the learner. */
  clusterId: string;
  rotation: string;
}

export interface TopicHeatmap {
  rotation: string;
  /** Weekly ready-counts over the trailing window; [] when the replay fails. */
  trend: ReadinessPoint[];
  /** Where the trend lands on exam day. Null when there is nothing to project. */
  projection: ReadinessProjection | null;
  /** Human label for the rotation, e.g. "CAH". Falls back to the slug. */
  rotationLabel: string;
  /** Days to the exam the map is aiming at. Drives how harshly staleness reads. */
  horizonDays: number;
  squares: TopicSquare[];
}

/** How many example card fronts each square carries, and how much of each. */
const SAMPLE_FRONTS_PER_TOPIC = 3;
const MAX_SAMPLE_FRONT_CHARS = 110;

interface ClusterHeatRow {
  cluster_id: string;
  cluster_name: string | null;
  item_count: number;
  seen_count: number;
  total_weight: number;
  held_weight: number;
  last_answered_at: Date | null;
  sample_fronts: string[];
}

/**
 * One row per cluster in the rotation, already weighted and windowed.
 *
 * Suppressed cards are excluded: a learner who has told us not to serve a card
 * should not be told they are behind on it. `lastReview` is the per-card
 * answer clock CardProgress already maintains, so this needs no LearningEvent
 * scan.
 */
async function loadClusterRows(
  userId: string,
  rotation: string,
  now: Date,
  horizonDays: number,
): Promise<ClusterHeatRow[]> {
  return prisma.$queryRaw<ClusterHeatRow[]>`
    SELECT
      c."clusterId"                 AS cluster_id,
      MAX(cl.name)                  AS cluster_name,
      COUNT(*)::int                 AS item_count,
      COUNT(p."lastReview")::int    AS seen_count,
      COALESCE(SUM(
        CASE c.difficulty
          WHEN 'easy' THEN ${DIFFICULTY_WEIGHT.easy}::float
          WHEN 'hard' THEN ${DIFFICULTY_WEIGHT.hard}::float
          ELSE ${DIFFICULTY_WEIGHT.medium}::float
        END
      ), 0)::float                  AS total_weight,
      -- itemReadiness() in topic-heat.ts, spelled in SQL: an item's exam-day
      -- recall as a fraction of the best it could be, sqrt((S+d)/(S+d+age)).
      -- Never-answered items contribute nothing and so drag the topic's mean
      -- down, which is how coverage enters the score.
      COALESCE(SUM(
        CASE WHEN p."lastReview" IS NULL THEN 0 ELSE
          (CASE c.difficulty
            WHEN 'easy' THEN ${DIFFICULTY_WEIGHT.easy}::float
            WHEN 'hard' THEN ${DIFFICULTY_WEIGHT.hard}::float
            ELSE ${DIFFICULTY_WEIGHT.medium}::float
          END)
          * SQRT(
              (GREATEST(COALESCE(p."stabilityDays", ${DEFAULT_STABILITY_DAYS}::float),
                        ${MIN_STABILITY_DAYS}::float) + ${horizonDays}::float)
              /
              (GREATEST(COALESCE(p."stabilityDays", ${DEFAULT_STABILITY_DAYS}::float),
                        ${MIN_STABILITY_DAYS}::float) + ${horizonDays}::float
               + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - p."lastReview")) / 86400))
            )
        END
      ), 0)::float                  AS held_weight,
      MAX(p."lastReview")           AS last_answered_at,
      -- A couple of real card fronts. The tidied cluster label says "Neurology";
      -- these say what the 9 cards in it actually ask, which is the question a
      -- learner is really asking when they hover a square.
      -- Ordered by a hash rather than by id: cards built from one sentence by
      -- moving the blank sit adjacent by id, so the first three would often be
      -- three phrasings of the same fact. A stable hash spreads the sample.
      (array_agg(LEFT(c.front, ${MAX_SAMPLE_FRONT_CHARS}) ORDER BY md5(c.id)))[1:${SAMPLE_FRONTS_PER_TOPIC}]
                                    AS sample_fronts
    FROM "Card" c
    JOIN "Cluster" cl ON cl.id = c."clusterId"
    LEFT JOIN "CardProgress" p
      ON p."cardId" = c.id AND p."userId" = ${userId}
    WHERE c.rotation = ${rotation}
      AND c."clusterId" IS NOT NULL
      -- Live cards only. Until 2026-09-15 this counted soft-deleted cards too:
      -- 1,054 of them in CAH alone, so every square's denominator was inflated
      -- and "80/129 ready" was not a real number. The square that surfaced it
      -- held exactly two cards, both dead since May, rendering as "1/2 studied
      -- · 23% ready" — and clicking it resolved to a cluster with zero LIVE
      -- cards in the rotation, which is how a topic square served an
      -- unrelated question from an unscoped session.
      AND c."deletedAt" IS NULL
      -- Drop the card entirely rather than counting it unseen: a suppressed
      -- card must not inflate the topic's denominator either.
      AND COALESCE(p.suppressed, false) = false
    GROUP BY c."clusterId"
  `;
}

/**
 * Days from now until this rotation's exam.
 *
 * Prefers the learner's own UserRotation date over the block default, ignores
 * the 2099 self-paced sentinel, and falls back to a fixed horizon when there
 * is no exam to aim at — a self-paced deck still deserves a working map, it
 * just has no deadline to tighten against.
 */
async function loadHorizonDays(
  userId: string,
  rotation: string,
  now: Date,
): Promise<number> {
  try {
    const examDate = await getExamDateForUser(rotation, userId);
    if (!examDate || isSelfPacedExamDate(examDate)) return DEFAULT_HORIZON_DAYS;
    const days = (examDate.getTime() - now.getTime()) / DAY_MS;
    // A past exam stops tightening the grid to nothing; the learner has moved on.
    return days > 0 ? days : DEFAULT_HORIZON_DAYS;
  } catch {
    return DEFAULT_HORIZON_DAYS;
  }
}

/** How far back the readiness replay reaches, sampling weekly. */
const TREND_WEEKS = 8;

/**
 * Replay the ready-count weekly over the trailing window.
 *
 * Every sample is scored against TODAY's horizon, not the horizon as it stood
 * then — see readiness-trend.ts for why. One query: sample dates cross-joined
 * against the rotation's cards, each card's most recent review before that
 * date, aggregated per cluster and counted. Sub-second on a rotation of a few
 * thousand cards: page-render territory, and nowhere near the serve path.
 */
async function loadTrend(
  userId: string,
  rotation: string,
  now: Date,
  horizonDays: number,
): Promise<ReadinessPoint[]> {
  const rows = await prisma.$queryRaw<{ d: string; ready: number }[]>`
    WITH samples AS (
      SELECT generate_series(
        ${now}::timestamptz - (${TREND_WEEKS * 7} || ' days')::interval,
        ${now}::timestamptz,
        interval '7 days'
      ) AS at
    ),
    cards AS (
      SELECT c.id, c."clusterId" cid,
             CASE c.difficulty
               WHEN 'easy' THEN ${DIFFICULTY_WEIGHT.easy}::float
               WHEN 'hard' THEN ${DIFFICULTY_WEIGHT.hard}::float
               ELSE ${DIFFICULTY_WEIGHT.medium}::float
             END w
      FROM "Card" c
      LEFT JOIN "CardProgress" p ON p."cardId" = c.id AND p."userId" = ${userId}
      WHERE c.rotation = ${rotation}
        AND c."clusterId" IS NOT NULL
        AND COALESCE(p.suppressed, false) = false
    ),
    -- One pass over this learner's card events, joined once. The obvious shape
    -- is a correlated "most recent review before this sample" subquery, and it
    -- costs samples x cards scans — 42k of them on this rotation, measured at
    -- 3.6s. Joining the events in and using a FILTER aggregate is the same
    -- answer in 0.4s.
    ev AS (
      SELECT e."sourceId" id, e.timestamp ts
      FROM "LearningEvent" e
      WHERE e."userId" = ${userId} AND e."sourceType" = 'card'
        -- 'card_reviewed' ONLY. Filtering on sourceType alone also catches
        -- content_exposed, which is an impression rather than an answer, and
        -- the trend then disagrees with the grid beside it, by a wide margin.
        -- CardProgress.lastReview, which the grid reads, moves on a graded
        -- review, so this must match it.
        AND e."eventType" = 'card_reviewed'
        AND e.timestamp >= ${now}::timestamptz - interval '400 days'
    ),
    per AS (
      SELECT s.at, cd.cid, cd.id, MIN(cd.w) w,
             MAX(ev.ts) FILTER (WHERE ev.ts <= s.at) last_at
      FROM samples s
      CROSS JOIN cards cd
      LEFT JOIN ev ON ev.id = cd.id
      GROUP BY s.at, cd.cid, cd.id
    ),
    scored AS (
      SELECT at, cid, SUM(w) tw,
        SUM(CASE WHEN last_at IS NULL THEN 0 ELSE
          w * SQRT(
            (${DEFAULT_STABILITY_DAYS}::float + ${horizonDays}::float)
            / (${DEFAULT_STABILITY_DAYS}::float + ${horizonDays}::float
               + GREATEST(0, EXTRACT(EPOCH FROM (at - last_at)) / 86400))
          ) END) hw
      FROM per GROUP BY 1, 2
    )
    SELECT to_char(at, 'YYYY-MM-DD') d,
           COUNT(*) FILTER (WHERE tw > 0 AND hw / tw >= ${WARM_CEILING}::float)::int ready
    FROM scored GROUP BY 1 ORDER BY 1
  `;
  return rows.map((row) => ({ date: row.d, ready: row.ready }));
}

/**
 * Stable order, by label.
 *
 * NOT sorted by heat, though that was the first instinct and it was wrong. A
 * grid ordered coldest-first bands into solid blocks — grey, then a red
 * column, then orange, then green — which is a stacked bar chart wearing a
 * heatmap's clothes. Worse, it makes position meaningless: a square moves
 * every time its score changes, so the learner can never learn where a topic
 * lives, and can never watch one turn green IN PLACE. Since the whole point is
 * "all green by exam day", the squares have to hold still for that to be
 * visible. The eye finds the red ones by colour; that is what colour is for.
 */
function sortStably(a: TopicSquare, b: TopicSquare): number {
  const byLabel = a.label.localeCompare(b.label);
  return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
}

/**
 * The knowledge heatmap for one learner: every cluster in the rotation they
 * are currently on, plus the pinned never-forget squares.
 *
 * Returns null when there is no current rotation or the read fails — the
 * profile hides the grid rather than showing a wall of false grey.
 */
export async function loadTopicHeatmap(
  userId: string,
  now: Date = new Date(),
): Promise<TopicHeatmap | null> {
  try {
    const rotation = await getCurrentRotation(userId);
    if (!rotation) return null;

    const horizonDays = await loadHorizonDays(userId, rotation, now);
    const [rows, trend] = await Promise.all([
      loadClusterRows(userId, rotation, now, horizonDays),
      // Best-effort: losing the trend costs a sparkline, never the grid.
      loadTrend(userId, rotation, now, horizonDays).catch((): ReadinessPoint[] => []),
    ]);

    const squares = rows
      .map((row): TopicSquare => ({
        ...classifyTopicHeat({
          itemCount: row.item_count,
          seenCount: row.seen_count,
          totalWeight: row.total_weight,
          heldWeight: row.held_weight,
          lastAnsweredAt: row.last_answered_at,
          now,
        }),
        id: row.cluster_id,
        // An authored name beats the generated one. The generator labels a
        // region by its commonest topic tag, which cannot separate siblings —
        // seven CAH regions came out as "Surgery". Regions we have explicitly
        // declined to name return null here and keep the generated label,
        // because inventing one would hide that they need splitting.
        label: authoredClusterName(row.cluster_id)
          ?? tidyClusterLabel(row.cluster_name ?? '', rotation),
        sampleFronts: (row.sample_fronts ?? []).filter((f): f is string => !!f),
        clusterId: row.cluster_id,
        rotation,
      }))
      .sort(sortStably);

    if (squares.length === 0) return null;
    return {
      rotation,
      trend,
      projection: trend.length > 0
        ? projectReadiness({ points: trend, totalTopics: squares.length, daysToExam: horizonDays })
        : null,
      rotationLabel: getRotation(rotation)?.shortName ?? rotation,
      horizonDays,
      squares,
    };
  } catch (error) {
    // Losing this costs one profile render's grid, never the page.
    logger.warn('Failed to load topic heatmap; hiding the grid', {
      userId,
      error: String(error),
    });
    return null;
  }
}
