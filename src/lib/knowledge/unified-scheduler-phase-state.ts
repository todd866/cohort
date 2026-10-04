/**
 * Unified scheduler: session build state
 *
 * The mutable bookkeeping that item selection shares across its lanes: the
 * items picked so far, the id sets and per-concept counts that keep later lanes
 * from repeating them, the new-card and cross-source budgets, and the
 * first-sight reservation. These were closure locals of the one big session
 * function; they live in one explicit object so each phase can take it as a
 * parameter. The method bodies were moved unchanged, with every outer name
 * now reached through `this`.
 */

import { prepareConceptThreadMatcher, type ClinicalThreadAnchor, type ConceptThreadMatch, type PreparedConceptThreadMatcher } from './concept-thread-policy';
import { classifyTeachingState, teachingArcFor } from '@/lib/scheduler/concept-teaching-state';
import type { BulkCandidates } from './bulk-candidates';
import type { CardCandidate } from './candidate-ranking';
import { questionSuppressionKey } from './variant-suppression';
import {
  type ConceptState,
  type UnifiedSessionItem,
  conceptThreadPolicyReceipt,
  parseSimilarLinks,
} from './unified-scheduler-types';

export interface SessionBuildStateInit {
  /** Seats in the session. */
  size: number;
  /** Minimum first-sight items the batch should keep (already clamped to size). */
  minFirstSightItems: number;
  /** New (unseen) cards allowed; Infinity when unbounded. */
  maxNewCards: number;
  /** Items allowed from cross-source rotations. */
  maxCrossSourceItems: number;
  unseenCardIds: ReadonlySet<string>;
  crossSourceCardIds: ReadonlySet<string>;
  crossSourceQuestionIds: ReadonlySet<string>;
  bulk: Pick<BulkCandidates, 'questionFamiliarity'>;
  /** Ids the session must not serve; the selected-id sets start as copies. */
  excludedCardIds: ReadonlySet<string>;
  excludedQuestionIds: ReadonlySet<string>;
  excludedVideoIds: ReadonlySet<string>;
  /** Concepts being worked this session; each gets a teaching-state item cap. */
  weakConcepts: readonly ConceptState[];
  conceptThreadAnchors: readonly ClinicalThreadAnchor[];
  nowMs: number;
}

export class SessionBuildState {
  readonly size: number;
  readonly minFirstSightItems: number;
  readonly maxNewCards: number;
  private readonly maxCrossSourceItems: number;
  private readonly unseenCardIds: ReadonlySet<string>;
  private readonly crossSourceCardIds: ReadonlySet<string>;
  private readonly crossSourceQuestionIds: ReadonlySet<string>;
  private readonly bulk: Pick<BulkCandidates, 'questionFamiliarity'>;

  // Selected items and the id sets that stop later lanes repeating them.
  readonly selectedItems: UnifiedSessionItem[] = [];
  readonly selectedConceptIds = new Set<string>();
  readonly selectedCardIds: Set<string>;
  readonly selectedQuestionIds: Set<string>;
  readonly selectedVideoIds: Set<string>;
  readonly selectedQuestionVariantGroups = new Set<string>();
  readonly selectedCardVariantGroups = new Set<string>();
  // Reserve at most one complementary concept-thread follow-up in a generated
  // batch. A selected presentation item can become a fresh anchor only after
  // the learner answers it, rather than dragging diagnosis and treatment into
  // the same prefetched burst. The item trace records which historical receipt
  // drove that one seat.
  conceptThreadFollowupSelected = false;
  private readonly preparedConceptThreadMatcher: PreparedConceptThreadMatcher;
  // Shared per-session budget for mastered questions re-entering rotation now that
  // permanent retirement is gone (see knowledge/question-retirement.ts). Shared
  // across every per-concept getQuestionsFromBulk call, like the Sets above.
  readonly masteredReentryCounter = { masteredServed: 0 };
  readonly cardsPerConcept = new Map<string, number>();
  readonly questionsPerConcept = new Map<string, number>();
  readonly videosPerConcept = new Map<string, number>();
  private readonly clusterCounts = new Map<string, number>();
  private readonly similarityToSelected = new Map<string, number>(); // cardId -> max similarity to any selected card
  // Exact optional recall passed to the card ranker for the item that won.
  // Post-order telemetry reads this instead of independently reconstructing a
  // default, so `applied=true` can never be emitted when the ladder was inert.
  readonly challengeRecallAtSelectionByCardId = new Map<string, number>();
  // Per-concept teaching arc — how many items each concept should consume
  // this session, based on its teaching state. naive=2, learning=3,
  // consolidating=3, mastered=1. The round-robin loops consult this
  // cap (instead of the previous one-size-fits-all HARD_MAX_CARDS_PER_CONCEPT
  // = 3) so mastered concepts no longer eat 3 slots for maintenance work
  // they don't need and the freed budget goes to weak concepts that do.
  //
  // Cap is total items per concept (cards + questions + pre-teach combined).
  // The 7a-naive section adds items for naive concepts before the loops run;
  // those count against this budget via cardsPerConcept/questionsPerConcept.
  private readonly conceptTeachingCap = new Map<string, number>();

  // Counters. Read through this object, never copied: every lane advances them.
  selectedCardCount = 0;
  selectedQuestionCount = 0;
  newCardCount = 0;
  selectedCrossSourceItems = 0;
  firstSightSelected = 0;
  enforceFirstSightReservation: boolean;
  readonly deferredForNovelty = new Map<string, UnifiedSessionItem>();
  selectedCoreTargetSeats = 0;
  selectedSurplusTargetSeats = 0;
  /**
   * Whether the core reservation met today's scheduled-core quota. Decided once,
   * right after that reservation; the later lanes and the ordering phase read it.
   */
  coreTargetQuotaSatisfied = false;

  constructor(init: SessionBuildStateInit) {
    this.size = init.size;
    this.minFirstSightItems = init.minFirstSightItems;
    this.maxNewCards = init.maxNewCards;
    this.maxCrossSourceItems = init.maxCrossSourceItems;
    this.unseenCardIds = init.unseenCardIds;
    this.crossSourceCardIds = init.crossSourceCardIds;
    this.crossSourceQuestionIds = init.crossSourceQuestionIds;
    this.bulk = init.bulk;
    this.selectedCardIds = new Set<string>(init.excludedCardIds);
    this.selectedQuestionIds = new Set<string>(init.excludedQuestionIds);
    this.selectedVideoIds = new Set<string>(init.excludedVideoIds);
    this.preparedConceptThreadMatcher = prepareConceptThreadMatcher(init.conceptThreadAnchors, init.nowMs);
    this.enforceFirstSightReservation = init.minFirstSightItems > 0;
    for (const cs of init.weakConcepts) {
      const state = classifyTeachingState({
        exposureCount: cs.exposureCount,
        recallOnExamDay: cs.recallOnExamDay,
        confidence: cs.confidence,
      });
      this.conceptTeachingCap.set(cs.conceptId, teachingArcFor(state).targetItems);
    }
  }

  readonly isFirstSightItem = (item: Pick<UnifiedSessionItem, 'type' | 'id'>): boolean =>
    item.type === 'card'
      ? this.unseenCardIds.has(item.id)
      : item.type === 'question' && !this.bulk.questionFamiliarity.has(item.id);

  private readonly isCrossSourceItem = (item: Pick<UnifiedSessionItem, 'type' | 'id'>): boolean =>
    item.type === 'card'
      ? this.crossSourceCardIds.has(item.id)
      : item.type === 'question' && this.crossSourceQuestionIds.has(item.id);

  readonly availableConceptThreadMatcher = () =>
    this.conceptThreadFollowupSelected
      ? undefined
      : this.preparedConceptThreadMatcher;

  recordAppliedChallengeRecall(cardId: string, recall: number | undefined): void {
    if (recall !== undefined && Number.isFinite(recall)) {
      this.challengeRecallAtSelectionByCardId.set(cardId, recall);
    }
  }

  teachingCapFor(conceptId: string): number {
    // Default 3 for concepts not in the weak-set (covers backfill paths
    // where teaching state wasn't computed). Matches old HARD_MAX behaviour.
    return this.conceptTeachingCap.get(conceptId) ?? 3;
  }

  conceptItemsSoFar(conceptId: string): number {
    return (this.cardsPerConcept.get(conceptId) ?? 0) + (this.questionsPerConcept.get(conceptId) ?? 0);
  }

  addItem(item: UnifiedSessionItem): boolean {
    if (this.selectedItems.length >= this.size) return false;
    const firstSight = this.isFirstSightItem(item);
    const seatsRemaining = this.size - this.selectedItems.length;
    const quotaRemaining = Math.max(0, this.minFirstSightItems - this.firstSightSelected);
    if (!firstSight && this.enforceFirstSightReservation && seatsRemaining <= quotaRemaining) {
      this.deferredForNovelty.set(`${item.type}:${item.id}`, item);
      return false;
    }
    // Every real-concept lane shares the same teaching budget. Keeping the
    // guard here prevents fallback, maintenance and orphan-rescue paths from
    // silently undoing the caps enforced by the primary round-robin loops.
    //
    // `_unattached` is an attribution bucket for unrelated orphan cards, not
    // a real concept, so counting it as one would truncate otherwise diverse
    // rescue content. Rotation top-up questions already use one synthetic id
    // per item, but are made explicit here for the same reason.
    const isSyntheticAttribution =
      item.conceptId === '_unattached' || item.conceptId.startsWith('rotation:');
    const crossSource = this.isCrossSourceItem(item);
    if (crossSource && this.selectedCrossSourceItems >= this.maxCrossSourceItems) {
      return false;
    }
    if (
      item.type !== 'video'
      && !isSyntheticAttribution
      && this.conceptItemsSoFar(item.conceptId) >= this.teachingCapFor(item.conceptId)
    ) {
      return false;
    }

    this.selectedItems.push(item);
    if (firstSight) this.firstSightSelected += 1;
    this.selectedConceptIds.add(item.conceptId);
    if (crossSource) this.selectedCrossSourceItems += 1;

    if (item.type === 'card') {
      this.selectedCardCount += 1;
      if (this.unseenCardIds.has(item.id)) this.newCardCount += 1;
      this.cardsPerConcept.set(item.conceptId, (this.cardsPerConcept.get(item.conceptId) ?? 0) + 1);
      this.selectedCardIds.add(item.id);
      // Record variant group on accept so pickCardCandidate (and any later
      // fallback path that takes this set as input) can refuse siblings.
      // Mirrors selectedQuestionVariantGroups for question variants.
      if (item.variantGroupId) this.selectedCardVariantGroups.add(item.variantGroupId);
      return true;
    }

    if (item.type === 'video') {
      this.videosPerConcept.set(item.conceptId, (this.videosPerConcept.get(item.conceptId) ?? 0) + 1);
      this.selectedVideoIds.add(item.id);
      return true;
    }

    this.selectedQuestionCount += 1;
    this.questionsPerConcept.set(item.conceptId, (this.questionsPerConcept.get(item.conceptId) ?? 0) + 1);
    this.selectedQuestionIds.add(item.id);
    const qSuppress = questionSuppressionKey(item);
    if (qSuppress) this.selectedQuestionVariantGroups.add(qSuppress);
    return true;
  }

  private wouldCauseInterference(candidate: CardCandidate, threshold: number): boolean {
    const knownSimilarity = this.similarityToSelected.get(candidate.id);
    if (typeof knownSimilarity === 'number' && knownSimilarity > threshold) return true;

    const links = parseSimilarLinks(candidate.similarCards);
    return links.some(
      (link) => this.selectedCardIds.has(link.cardId) && link.similarity > threshold
    );
  }

  recordCardNeighborhood(candidate: CardCandidate): void {
    const links = parseSimilarLinks(candidate.similarCards);
    for (const link of links) {
      const current = this.similarityToSelected.get(link.cardId) ?? 0;
      if (link.similarity > current) this.similarityToSelected.set(link.cardId, link.similarity);
    }
  }

  private canUseCluster(clusterId: string | null, maxPerCluster: number): boolean {
    if (!clusterId) return true;
    return (this.clusterCounts.get(clusterId) ?? 0) < maxPerCluster;
  }

  recordCluster(clusterId: string | null): void {
    if (!clusterId) return;
    this.clusterCounts.set(clusterId, (this.clusterCounts.get(clusterId) ?? 0) + 1);
  }

  pickCardCandidate(
    candidates: CardCandidate[],
    constraints: { similarityThreshold: number; maxPerCluster: number }
  ): CardCandidate | null {
    for (const candidate of candidates) {
      if (this.selectedCardIds.has(candidate.id)) continue;
      if (
        this.crossSourceCardIds.has(candidate.id)
        && this.selectedCrossSourceItems >= this.maxCrossSourceItems
      ) continue;
      // Sibling suppression: refuse any candidate whose cloze-variant group is
      // already represented in this session. Prevents serving 2-3 near-identical
      // cloze cards back-to-back. Mirrors the question variant suppression.
      if (candidate.variantGroupId && this.selectedCardVariantGroups.has(candidate.variantGroupId)) continue;
      // Skip unseen cards when new-card budget is exhausted
      if (this.unseenCardIds.has(candidate.id) && this.newCardCount >= this.maxNewCards) continue;
      if (!this.canUseCluster(candidate.clusterId, constraints.maxPerCluster)) continue;
      if (this.wouldCauseInterference(candidate, constraints.similarityThreshold)) continue;
      return candidate;
    }
    return null;
  }
}

export const conceptThreadTrace = (match?: ConceptThreadMatch): Partial<UnifiedSessionItem> => ({
  ...conceptThreadPolicyReceipt(),
  ...(match ? { conceptThreadPolicyApplied: true } : {}),
  ...(match ? {
    conceptThreadAnchorEventId: match.anchorEventId,
    conceptThreadAnchorItemId: match.anchorItemId,
    conceptThreadAnchorFacet: match.anchorFacet,
    conceptThreadTargetFacet: match.targetFacet,
    conceptThreadSharedTopic: match.sharedTopic,
    conceptThreadAgeMs: match.ageMs,
    conceptThreadInterveningExposures: match.interveningExposures,
  } : {}),
});
