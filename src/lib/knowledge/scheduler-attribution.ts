import { normalizeTopic } from '@/lib/topics';

export interface ConceptTopicSource {
  id: string;
  topics: readonly string[];
}

export interface CardConceptSource {
  conceptId: string | null;
  topics: readonly string[];
}

export type ConceptTopicIndex = ReadonlyMap<string, ReadonlySet<string>>;

export interface CardSignalRow {
  liked: boolean;
  totalReviews: number;
  correctCount: number;
  card: CardConceptSource & { id: string };
}

export interface ServedCardConceptRow {
  itemId: string;
  conceptId: string | null;
}

export interface CardSignalConcepts {
  liked: Set<string>;
  chronic: Set<string>;
}

export interface ServedFailureRow {
  conceptId: string | null;
}

export interface LegacyCardFailureRow {
  card: CardConceptSource;
}

export interface LegacyQuestionFailureRow {
  question: { concepts: ReadonlyArray<{ conceptId: string }> };
}

/** Build the normalized topic lookup shared by all fallback attribution. */
export function buildConceptTopicIndex(
  concepts: readonly ConceptTopicSource[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const concept of concepts) {
    for (const topic of concept.topics) {
      const normalized = normalizeTopic(topic);
      if (!normalized) continue;
      const ids = index.get(normalized) ?? new Set<string>();
      ids.add(concept.id);
      index.set(normalized, ids);
    }
  }
  return index;
}

function conceptIdsForTopics(
  topics: readonly string[],
  conceptTopicIndex: ConceptTopicIndex,
): Set<string> {
  const ids = new Set<string>();
  for (const topic of topics) {
    const normalized = normalizeTopic(topic);
    if (!normalized) continue;
    for (const conceptId of conceptTopicIndex.get(normalized) ?? []) {
      ids.add(conceptId);
    }
  }
  return ids;
}

/**
 * Resolve a card to one in-scope concept without spreading broad topic signals
 * across every concept that shares the tag.
 */
export function resolveCardConceptId(
  card: CardConceptSource,
  currentConceptIds: ReadonlySet<string>,
  conceptTopicIndex: ConceptTopicIndex,
): string | null {
  if (card.conceptId && currentConceptIds.has(card.conceptId)) return card.conceptId;

  const topicMatches = conceptIdsForTopics(card.topics, conceptTopicIndex);
  return topicMatches.size === 1
    ? (topicMatches.values().next().value ?? null)
    : null;
}

/**
 * Collapse card-history rows into the two concept-level scheduler signals.
 * `servedRowsNewestFirst` must retain the query's descending decision order so
 * the first attribution for a card is its latest delivery-grounded one.
 */
export function deriveCardSignalConcepts({
  rows,
  servedRowsNewestFirst,
  currentConceptIds,
  conceptTopicIndex,
}: {
  rows: readonly CardSignalRow[];
  servedRowsNewestFirst: readonly ServedCardConceptRow[];
  currentConceptIds: ReadonlySet<string>;
  conceptTopicIndex: ConceptTopicIndex;
}): CardSignalConcepts {
  const servedConceptByCard = new Map<string, string>();
  for (const row of servedRowsNewestFirst) {
    if (row.conceptId && !servedConceptByCard.has(row.itemId)) {
      servedConceptByCard.set(row.itemId, row.conceptId);
    }
  }

  const liked = new Set<string>();
  const chronic = new Set<string>();
  for (const row of rows) {
    const conceptId = servedConceptByCard.get(row.card.id)
      ?? resolveCardConceptId(row.card, currentConceptIds, conceptTopicIndex);
    if (!conceptId) continue;

    if (row.liked) liked.add(conceptId);
    const accuracy = row.totalReviews > 0
      ? row.correctCount / row.totalReviews
      : 1;
    if (row.totalReviews >= 3 && accuracy <= 0.5) chronic.add(conceptId);
  }

  return { liked, chronic };
}

/** Combine delivery-grounded failures with compatibility fallback rows. */
export function deriveRecentFailureConceptIds({
  servedFailures,
  cardFailures,
  questionFailures,
  currentConceptIds,
  conceptTopicIndex,
}: {
  servedFailures: readonly ServedFailureRow[];
  cardFailures: readonly LegacyCardFailureRow[];
  questionFailures: readonly LegacyQuestionFailureRow[];
  currentConceptIds: ReadonlySet<string>;
  conceptTopicIndex: ConceptTopicIndex;
}): Set<string> {
  const ids = new Set<string>();
  for (const row of servedFailures) {
    if (row.conceptId) ids.add(row.conceptId);
  }
  for (const row of cardFailures) {
    const conceptId = resolveCardConceptId(
      row.card,
      currentConceptIds,
      conceptTopicIndex,
    );
    if (conceptId) ids.add(conceptId);
  }
  for (const row of questionFailures) {
    for (const concept of row.question.concepts) ids.add(concept.conceptId);
  }
  return ids;
}
