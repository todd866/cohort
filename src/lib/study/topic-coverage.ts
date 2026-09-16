/**
 * Topic coverage: the share of a rotation's topics the learner has met.
 *
 * The previous coverage figure was seen-items over servable-items, which made
 * every authoring night a step backwards for every learner — 575 CAH cards
 * landed in the week to 2026-09-16 and a learner's bar did not move however
 * much they studied. Content growth is not the learner's regression.
 *
 * A topic is a cluster. It counts as met once a handful of its items have been
 * seen (`TOPIC_COVERAGE_ITEMS`, or all of them for a smaller topic); items
 * beyond that add nothing, so more cards in a known topic never move the
 * number. A genuinely new topic does lower it, which is the honest case.
 * Topics weigh equally — a 60-card cluster is one topic, not sixty.
 */

/** Seen items at which a topic counts as fully met. */
export const TOPIC_COVERAGE_ITEMS = 5;

export interface TopicCoverageInput {
  clusterId: string;
  /** Live, servable items in the cluster. */
  items: number;
  /** Items in the cluster the learner has reviewed at least once. */
  seen: number;
}

export interface TopicCoverage {
  /** 0–100, floored. */
  percent: number;
  /** Topics fully met. */
  coveredTopics: number;
  /** Topics with at least one live item. */
  totalTopics: number;
}

export function computeTopicCoverage(clusters: readonly TopicCoverageInput[]): TopicCoverage {
  const live = clusters.filter(c => c.items > 0);
  if (live.length === 0) return { percent: 0, coveredTopics: 0, totalTopics: 0 };
  let sum = 0;
  let covered = 0;
  for (const c of live) {
    const needed = Math.min(c.items, TOPIC_COVERAGE_ITEMS);
    const fraction = Math.min(1, Math.max(0, c.seen) / needed);
    sum += fraction;
    if (fraction >= 1) covered += 1;
  }
  return {
    percent: Math.floor((sum / live.length) * 100),
    coveredTopics: covered,
    totalTopics: live.length,
  };
}
