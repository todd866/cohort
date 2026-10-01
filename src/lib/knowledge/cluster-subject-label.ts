import { authoredClusterName } from './cluster-name-overlay';
import { tidyClusterLabel } from './cluster-label';
import { primaryTopicOf } from './primary-topic';

/**
 * How a cluster introduces itself.
 *
 * The stored `Cluster.name` is the three most common topic tags. A week title
 * such as "Gastroenterology, Ophthalmology & Renal" is stamped on every card
 * under it, so those tags outvote the heading the card actually sits under and
 * a constipation neighbourhood introduces itself as two specialties.
 *
 * The nearest heading is the subject. An authored overlay still wins, because
 * those names were read off the cards on purpose. The stored name remains the
 * fallback for a region whose cards carry no subject at all.
 */

/** A region at least this large is a candidate for a geometric split. */
export const SPLIT_MIN_CARDS = 80;

/**
 * At or above this size a region is split even when one heading covers half
 * of it. Below it, a region that is mostly one heading stays whole.
 */
export const SPLIT_FORCE_CARDS = 160;

/** One heading covering this share, or more, means the region is one subject. */
export const SPLIT_SUBJECT_SHARE = 0.5;

const NONE = '(none)';

export interface SubjectProfile {
  /** The commonest nearest heading, ignoring cards with no subject. */
  subject: string | null;
  /** Share of member cards carrying that heading. Zero when nothing is a subject. */
  subjectShare: number;
  /**
   * Share of the single biggest bucket, where cards with no subject share one
   * bucket. This is the eligibility figure: a region that is half furniture is
   * not "mostly one heading".
   */
  topShare: number;
}

export function subjectProfile(topicLists: readonly (readonly string[])[]): SubjectProfile {
  const counts = new Map<string, number>();
  for (const topics of topicLists) {
    const subject = primaryTopicOf(topics) ?? NONE;
    counts.set(subject, (counts.get(subject) ?? 0) + 1);
  }

  let top = NONE;
  let topCount = 0;
  let subject: string | null = null;
  let subjectCount = 0;
  for (const [name, count] of counts) {
    if (count > topCount || (count === topCount && name.localeCompare(top) < 0)) {
      top = name;
      topCount = count;
    }
    if (name === NONE) continue;
    if (count > subjectCount || (count === subjectCount && (subject === null || name.localeCompare(subject) < 0))) {
      subject = name;
      subjectCount = count;
    }
  }

  const total = topicLists.length;
  return {
    subject,
    subjectShare: total === 0 ? 0 : subjectCount / total,
    topShare: total === 0 ? 0 : topCount / total,
  };
}

export function clusterSplitEligible(cardCount: number, topShare: number): boolean {
  return cardCount >= SPLIT_MIN_CARDS
    && (topShare < SPLIT_SUBJECT_SHARE || cardCount >= SPLIT_FORCE_CARDS);
}

/**
 * Process headings ("Treating it", "What it is") are nearest to the card and
 * would otherwise name a whole region. A heading made only of these words is
 * not a name.
 */
const WEAK_HEADING_WORDS = new Set([
  'a', 'an', 'and', 'are', 'child', 'children', 'different', 'empiric', 'film',
  'for', 'how', 'in', 'initial', 'investigating', 'investigation', 'is', 'it',
  'its', 'management', 'managing', 'more', 'of', 'on', 'or', 'other', 'putting',
  'reading', 'recognising', 'recognizing', 'recognition', 'same', 'stretch',
  'the', 'to', 'together', 'treating', 'treatment', 'two', 'what', 'when', 'why',
]);

export function isWeakClusterHeading(heading: string): boolean {
  const words = heading.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length === 0 || words.every((word) => WEAK_HEADING_WORDS.has(word));
}

export function rankedSubjects(
  topicLists: readonly (readonly string[])[],
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const topics of topicLists) {
    const subject = primaryTopicOf(topics);
    if (!subject || isWeakClusterHeading(subject)) continue;
    counts.set(subject, (counts.get(subject) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Replace the stored label only when it is still the old two-fragment
 * labeller output and the nearest heading is a subject that label does not
 * already contain. A clean name, including one written by a previous split,
 * stays put. "ENT · Surgery" stays when the heading is Surgery.
 * "Gastroenterology · Ophthalmology" gives way to Encopresis.
 */
export function preferSubjectLabel(tidyLabel: string, subject: string): boolean {
  if (!tidyLabel.includes(' · ')) return false;
  if (isWeakClusterHeading(subject)) return false;
  return !tidyLabel.toLowerCase().includes(subject.toLowerCase());
}

export function labelForMembers(
  topicLists: readonly (readonly string[])[],
  fallback: string,
): string {
  const ranked = rankedSubjects(topicLists);
  const top = ranked[0];
  if (!top || topicLists.length === 0 || top.count / topicLists.length < 0.2) {
    return fallback;
  }
  return top.name;
}

/** When sibling leaves would share a label, append the next real heading. */
export function disambiguateMemberLabels(
  leaves: readonly { id: string; topicLists: readonly (readonly string[])[] }[],
  fallback: string,
): Map<string, string> {
  const named = leaves.map((leaf) => ({
    id: leaf.id,
    ranked: rankedSubjects(leaf.topicLists),
    name: labelForMembers(leaf.topicLists, fallback),
  }));
  const used = new Map<string, number>();
  for (const leaf of named) used.set(leaf.name, (used.get(leaf.name) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const leaf of named) {
    if ((used.get(leaf.name) ?? 0) < 2) {
      labels.set(leaf.id, leaf.name);
      continue;
    }
    const next = leaf.ranked.find((entry) => entry.name !== leaf.name && entry.count >= 2);
    labels.set(leaf.id, next ? `${leaf.name} · ${next.name}` : leaf.name);
  }
  return labels;
}

export function resolveClusterLabel(args: {
  clusterId: string;
  storedName: string;
  rotation: string;
  memberTopics: readonly (readonly string[])[];
}): string {
  const authored = authoredClusterName(args.clusterId);
  if (authored) return authored;
  const tidy = tidyClusterLabel(args.storedName, args.rotation);
  const subject = subjectProfile(args.memberTopics).subject;
  if (subject && preferSubjectLabel(tidy, subject)) return subject;
  return tidy;
}
