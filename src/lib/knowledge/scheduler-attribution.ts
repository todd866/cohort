import { normalizeTopic } from '@/lib/topics';
import { trustedServeDecisionIdFromMetadata } from '@/lib/study/serve-decision-provenance';
import { isSyntheticConceptAttribution } from './synthetic-concept';

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
  id?: string;
  itemType?: string;
  itemId?: string;
  isCorrect?: boolean | null;
}

export interface LegacyCardFailureRow {
  card: CardConceptSource;
}

export interface LegacyQuestionFailureRow {
  question: { concepts: ReadonlyArray<{ conceptId: string }> };
  responseId?: string;
  questionId?: string;
  createdAt?: Date;
  responseKeyCount?: number;
  eventCandidates?: readonly QuestionFailureEvent[];
}

export interface QuestionFailureEvent {
  id: string;
  eventType: string;
  sourceType: string;
  sourceId: string;
  timestamp: string;
  isCorrect: boolean | null;
  conceptIds: string[];
  metadata: unknown;
}

/** Ephemeral background read; never accepted from a request or persisted. */
export interface RecentQuestionFailureSnapshot {
  userId: string;
  rotation: string;
  week: number | null;
  generatedAtMs: number;
  cutoffMs: number;
  rows: readonly LegacyQuestionFailureRow[];
}

export const ACUTE_FAILURE_WINDOW_MS = 2 * 60 * 60 * 1000;
// A read carried between adjacent background stages, not a durable cache.
export const FAILURE_SNAPSHOT_MAX_AGE_MS = 30_000;

export function recentQuestionFailureRows(
  snapshot: RecentQuestionFailureSnapshot | undefined,
  context: { userId: string; rotation: string; week: number | null; nowMs: number },
): readonly LegacyQuestionFailureRow[] | null {
  if (!snapshot
    || snapshot.userId !== context.userId
    || snapshot.rotation !== context.rotation
    || snapshot.week !== context.week
    || !Number.isFinite(snapshot.generatedAtMs)
    || !Number.isFinite(context.nowMs)
    || snapshot.generatedAtMs > context.nowMs
    || context.nowMs - snapshot.generatedAtMs > FAILURE_SNAPSHOT_MAX_AGE_MS
    || snapshot.cutoffMs !== snapshot.generatedAtMs - ACUTE_FAILURE_WINDOW_MS
  ) return null;
  const cutoffMs = context.nowMs - ACUTE_FAILURE_WINDOW_MS;
  return snapshot.rows.filter(row => (
    row.createdAt && row.createdAt.getTime() >= cutoffMs
    && row.createdAt.getTime() <= snapshot.generatedAtMs
  ));
}

/**
 * The canonical writer commits the response and event with the same timestamp.
 * A delivered decision uses a later server clock, so it is joined by the event's
 * trusted decision ID instead. Any ambiguity keeps compatibility attribution.
 */
function hasAuthoritativeQuestionFailure(
  row: LegacyQuestionFailureRow,
  servedById: ReadonlyMap<string, ServedFailureRow>,
  currentConceptIds: ReadonlySet<string>,
): boolean {
  if (!row.responseId || !row.questionId || row.responseKeyCount !== 1) return false;
  if (row.eventCandidates?.length !== 1) return false;
  const event = row.eventCandidates[0];
  const responseAt = row.createdAt?.getTime();
  if (!Number.isFinite(responseAt) || new Date(event.timestamp).getTime() !== responseAt) return false;
  if (
    !event.id
    || event.eventType !== 'mcq_attempted'
    || event.sourceType !== 'question'
    || event.sourceId !== row.questionId
    || event.isCorrect !== false
    || event.conceptIds.length !== 1
  ) return false;
  const conceptId = event.conceptIds[0];
  if (!currentConceptIds.has(conceptId) || isSyntheticConceptAttribution(conceptId)) return false;
  const decisionId = trustedServeDecisionIdFromMetadata(event.metadata);
  const decision = decisionId ? servedById.get(decisionId) : undefined;
  return decision?.itemType === 'question'
    && decision.itemId === row.questionId
    && decision.isCorrect === false
    && decision.conceptId === conceptId;
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
  const servedById = new Map<string, ServedFailureRow>();
  for (const row of servedFailures) {
    if (row.conceptId) ids.add(row.conceptId);
    if (row.id) servedById.set(row.id, row);
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
    if (hasAuthoritativeQuestionFailure(row, servedById, currentConceptIds)) continue;
    for (const concept of row.question.concepts) ids.add(concept.conceptId);
  }
  return ids;
}
