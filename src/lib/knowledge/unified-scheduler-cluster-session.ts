/**
 * Unified scheduler: cluster-driven fallback
 *
 * Builds a session from manifold clusters for rotations that have no Concept
 * rows. Moved out of unified-scheduler.ts unchanged; constructUnifiedSession
 * calls constructClusterSession when a rotation has no concepts.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getClusterMastery } from '@/lib/manifold/clustering';
import { sessionCandidateItemWhere } from '@/lib/knowledge/session-candidate-scope';
import { batchLoadItemEmbeddings } from '@/lib/manifold';
import { loadQuestionFamiliarity } from './bulk-candidates';
import { questionSuppressionKey } from './variant-suppression';
import { orderByManifoldWalk, computeConceptPairingRate } from './manifold-walk';
import { injectPreemptiveScaffoldsFromPool } from './preemptive-scaffold';
import { breakModalityRuns } from './modality-guard';
import { classifyTeachingState, teachingArcFor } from '@/lib/scheduler/concept-teaching-state';
import {
  type UnifiedSessionItem,
  type UnifiedSessionResult,
  type UnifiedSessionSelectionDeterminism,
  conceptThreadPolicyReceipt,
} from './unified-scheduler-types';
import { enforceConceptTeachingCaps } from './unified-scheduler-scoring';
import {
  getCardsForCluster,
  getQuestionsForRotation,
  getUnseenScaffoldsForClusters,
} from './unified-scheduler-queries';

// =============================================================================
// Cluster-Driven Fallback (for rotations without Concept rows)
// =============================================================================

/** Complexity floor the cluster fallback applies to every card it considers. */
const CLUSTER_FALLBACK_MIN_COMPLEXITY = 2;

/**
 * Keep only the clusters that hold at least one card this session may serve.
 *
 * The cluster fallback queries per cluster per pass, so a widened cluster list
 * is a per-request cost: the GSSE corpus bootstraps into 132 clusters and a
 * neurosurgery session can reach barely a twelfth of the cards in them. One
 * grouped query answers "which clusters are worth visiting" up front, which
 * keeps the fallback's query count proportional to what it can actually use.
 */
async function restrictToClustersWithEligibleCards<T extends { clusterId: string }>(
  clusters: readonly T[],
  scope: {
    rotation: string;
    crossSourceRotations: readonly string[];
    crossSourceMappingMode: 'adjacent' | 'open';
    /**
     * Mirror the complexity floor both per-cluster queries apply. Without it the
     * pre-filter admits clusters whose only reachable cards are scaffold-tier,
     * and the loop pays two queries to discover that. The GSSE corpus is almost
     * exactly half complexity-1, so this is not a marginal saving.
     */
    minComplexity?: number;
  },
): Promise<T[]> {
  if (clusters.length === 0) return [];

  const groups = await prisma.card.groupBy({
    by: ['clusterId'],
    where: {
      ...sessionCandidateItemWhere(
        scope.rotation,
        scope.crossSourceRotations,
        scope.crossSourceMappingMode,
      ),
      clusterId: { in: clusters.map((cluster) => cluster.clusterId) },
      deletedAt: null,
      shelvedAt: null,
      ...(scope.minComplexity != null
        ? { complexity: { gte: scope.minComplexity } }
        : {}),
    },
  });

  const eligible = new Set(
    groups
      .map((group) => group.clusterId)
      .filter((clusterId): clusterId is string => typeof clusterId === 'string'),
  );
  return clusters.filter((cluster) => eligible.has(cluster.clusterId));
}

export async function constructClusterSession(
  userId: string,
  options: {
    rotation: string;
    size: number;
    cardRatio: number;
    maxNewCards: number;
    minFirstSightItems: number;
    excludeCardIds: string[];
    excludeQuestionIds: string[];
    selectionDeterminism?: UnifiedSessionSelectionDeterminism;
    practiceLocale?: 'au' | 'us';
    crossSourceRotations?: readonly string[];
    crossSourceMappingMode?: 'adjacent' | 'open';
    isCopyrightTier?: boolean;
  }
): Promise<UnifiedSessionResult> {
  const {
    rotation,
    size,
    cardRatio,
    maxNewCards,
    minFirstSightItems,
    excludeCardIds,
    excludeQuestionIds,
    selectionDeterminism,
  } = options;

  const crossSourceRotations = options.crossSourceRotations ?? [];
  const crossSourceMappingMode = options.crossSourceMappingMode ?? 'adjacent';
  // A view rotation (`neurosurg`) owns no cards and therefore no clusters of
  // its own — they are stamped with the host corpus. Ask for the companions too
  // or the fallback returns empty however much content the view can reach.
  const clusterScope = {
    ...(crossSourceRotations.length > 0
      ? { additionalRotations: crossSourceRotations }
      : {}),
  };
  const allClusters = selectionDeterminism
    ? await getClusterMastery(userId, rotation, {
        ...clusterScope,
        now: new Date(selectionDeterminism.nowMs),
      })
    : await getClusterMastery(userId, rotation, clusterScope);

  // Widening the search also widens the miss rate: the GSSE corpus bootstraps
  // into 132 clusters and only a fraction hold a neurosurgical plate. Resolve
  // which clusters actually carry an eligible card in ONE grouped query rather
  // than discovering it with a per-cluster query per pass on a request path.
  const clusters = crossSourceRotations.length > 0
    ? await restrictToClustersWithEligibleCards(allClusters, {
        rotation,
        crossSourceRotations,
        crossSourceMappingMode,
        minComplexity: CLUSTER_FALLBACK_MIN_COMPLEXITY,
      })
    : allClusters;
  if (clusters.length === 0) {
    // Cluster fallback found no clusters either → empty session. Logged so this
    // root cause is distinguishable from "user genuinely finished the rotation".
    logger.warn('scheduler: cluster fallback produced empty session', { rotation });
    return {
      items: [],
      noveltyQuota: {
        required: Math.min(size, Math.max(0, Math.floor(minFirstSightItems))),
        selected: 0,
      },
      stats: {
        totalConcepts: 0,
        weakConcepts: 0,
        selectedConcepts: 0,
        cardCount: 0,
        questionCount: 0,
        averagePriority: 0,
      },
    };
  }

  const clusterStates = clusters.map((cluster) => {
    const coverage = cluster.cardCount > 0 ? cluster.cardsReviewed / cluster.cardCount : 1;
    const mastery = cluster.mastery ?? 0;
    const priority = (1 - coverage) * 0.6 + (1 - mastery) * 0.4 + (cluster.needsAttention ? 0.1 : 0);
    return {
      ...cluster,
      coverage,
      priority,
    };
  });

  clusterStates.sort((a, b) => b.priority - a.priority);

  const targetCardCount = Math.ceil(size * cardRatio);
  const targetQuestionCount = size - targetCardCount;
  const requiredFirstSight = Math.min(
    size,
    Math.max(0, Math.floor(minFirstSightItems)),
  );

  const selectedItems: UnifiedSessionItem[] = [];
  const selectedCardIds = new Set<string>(excludeCardIds);
  const selectedQuestionIds = new Set<string>(excludeQuestionIds);
  const selectedCardVariantGroups = new Set<string>();
  const selectedQuestionVariantGroups = new Set<string>();
  const cardsPerCluster = new Map<string, number>();
  const selectedClusterIds = new Set<string>();

  let selectedCardCount = 0;

  for (let pass = 0; selectedCardCount < targetCardCount; pass++) {
    const maxPerCluster = 2 + pass;
    let addedThisPass = 0;

    for (const cluster of clusterStates) {
      if (selectedCardCount >= targetCardCount) break;
      const already = cardsPerCluster.get(cluster.clusterId) ?? 0;
      if (already >= maxPerCluster) continue;

      const candidates = await getCardsForCluster(userId, rotation, cluster.clusterId, 12, {
        selectedCardIds,
        minComplexity: CLUSTER_FALLBACK_MIN_COMPLEXITY,
        crossSourceRotations,
        crossSourceMappingMode,
        isCopyrightTier: options.isCopyrightTier === true,
        practiceLocale: options.practiceLocale ?? 'au',
        now: selectionDeterminism
          ? new Date(selectionDeterminism.nowMs)
          : new Date(),
        ...(selectionDeterminism ? { selectionDeterminism } : {}),
      });
      if (candidates.length === 0) continue;

      const picked = candidates.find(
        (candidate) => !candidate.variantGroupId
          || !selectedCardVariantGroups.has(candidate.variantGroupId),
      );
      if (!picked) continue;
      selectedItems.push({
        type: 'card',
        id: picked.id,
        conceptId: cluster.clusterId,
        conceptName: cluster.clusterName,
        priority: cluster.priority,
        interventionReason: cluster.mastery < 0.6 ? 'weak_recall' : 'reinforcement',
        rotation,
        topics: picked.topics,
        complexity: picked.complexity,
        clusterId: picked.clusterId,
        variantGroupId: picked.variantGroupId,
        variantIndex: picked.variantIndex,
        variantType: picked.variantType,
        firstSightAtSelection: picked.firstSightAtSelection,
      });

      selectedCardIds.add(picked.id);
      if (picked.variantGroupId) selectedCardVariantGroups.add(picked.variantGroupId);
      selectedCardCount += 1;
      cardsPerCluster.set(cluster.clusterId, already + 1);
      selectedClusterIds.add(cluster.clusterId);
      addedThisPass += 1;
    }

    if (addedThisPass === 0) break;
  }

  const firstSightQuestionIds = new Set<string>();
  const questionCandidateCount = Math.max(targetQuestionCount, requiredFirstSight);
  if (questionCandidateCount > 0) {
    // This fallback path returns before bulkFetchCandidates, so it has no familiarity
    // map — load one. Without it selectVariantAwareQuestions would draw mastered and
    // fresh questions with equal probability (it is only never-answered-first WITHIN a
    // variant group; see the note in getQuestionsForRotation).
    const questionFamiliarity = await loadQuestionFamiliarity(
      prisma as unknown as Parameters<typeof loadQuestionFamiliarity>[0],
      userId,
    );
    const questions = await getQuestionsForRotation(userId, rotation, questionCandidateCount, {
      selectedQuestionIds,
      selectedQuestionVariantGroups,
      questionFamiliarity,
      masteredReentryCounter: { masteredServed: 0 },
      crossSourceRotations,
      crossSourceMappingMode,
      ...(selectionDeterminism ? { selectionDeterminism } : {}),
    });

    for (const q of questions) {
      if (!questionFamiliarity.has(q.id)) firstSightQuestionIds.add(q.id);
      selectedItems.push({
        type: 'question',
        id: q.id,
        conceptId: `question:${q.id}`,
        conceptName: 'Rotation probe',
        priority: 0.5,
        interventionReason: 'needs_retest',
        ...conceptThreadPolicyReceipt(),
        rotation: q.rotation,
        topics: q.topics,
        variantGroupId: q.variantGroupId,
        variantType: q.variantType,
        firstSightAtSelection: firstSightQuestionIds.has(q.id),
      });
      const suppressKey = questionSuppressionKey(q);
      if (suppressKey) selectedQuestionVariantGroups.add(suppressKey);
    }
  }
  const clusterQuotaCandidates = [...selectedItems];

  // Cluster fallback has no shared bulk candidate snapshot, so gather enough
  // questions to let novelty cross the configured card/question ratio. Reserve
  // first-sight membership first, then preserve the fallback's original order
  // for the remaining seats.
  if (requiredFirstSight > 0 && selectedItems.length > size) {
    const firstSight = selectedItems
      .filter((item) => item.firstSightAtSelection)
      .slice(0, requiredFirstSight);
    const reserved = new Set(firstSight.map((item) => `${item.type}:${item.id}`));
    const prioritized = [
      ...firstSight,
      ...selectedItems.filter((item) => !reserved.has(`${item.type}:${item.id}`)),
    ].slice(0, size);
    selectedItems.splice(0, selectedItems.length, ...prioritized);
  }

  const clusterCardIds = selectedItems.filter((i) => i.type === 'card').map((i) => i.id);
  const clusterQuestionIds = selectedItems.filter((i) => i.type === 'question').map((i) => i.id);
  const clusterEmbeddings = await batchLoadItemEmbeddings(clusterCardIds, clusterQuestionIds);
  const clusterOrdered = orderByManifoldWalk(selectedItems, clusterEmbeddings);

  // Cluster-only rotations do not go through bulkFetchCandidates, so build the
  // smallest possible pool for the shared preemptive-scaffold pass here. Keep
  // C1 cards out of the anchor selection above, then pair only unseen C1 cards
  // from the exact clusters represented in this session. The caller's recent
  // and explicit exclusions are already present in selectedCardIds.
  // Same rotation seed contract as constructUnifiedSessionImpl: without it the
  // lowest-index eligible C1 becomes its cluster's permanent scaffold.
  const servingRotationSeed = options.selectionDeterminism
    ? `serving:${options.selectionDeterminism.seed}`
    : `serving:${userId}:${new Date().toISOString().slice(0, 13)}`;
  const unseenClusterScaffolds = maxNewCards === 0
    ? []
    : await getUnseenScaffoldsForClusters(
        userId,
        rotation,
        [...selectedClusterIds],
        selectedCardIds,
      );
  const scaffoldPaired = injectPreemptiveScaffoldsFromPool(
    clusterOrdered,
    {
      rotation,
      candidateCards: unseenClusterScaffolds,
    },
    {
      matchBy: 'cluster',
      rotationSeed: servingRotationSeed,
      // A review-only/crunch session must not grow by introducing pristine C1
      // cards after its anchor budget has already been assembled.
      maxPairings: maxNewCards === 0 ? 0 : undefined,
    },
  );

  // The shared scaffold candidate shape is intentionally minimal. Restore the
  // cloze-variant identity carried by the full cluster candidate so hydration,
  // sibling suppression, and walk audits see the same metadata as anchors.
  const scaffoldMetaById = new Map(unseenClusterScaffolds.map((card) => [card.id, card]));
  for (const item of scaffoldPaired) {
    if (item.type !== 'card' || item.interventionReason !== 'preemptive_scaffold') continue;
    const meta = scaffoldMetaById.get(item.id);
    if (!meta) continue;
    item.variantGroupId = meta.variantGroupId;
    item.variantIndex = meta.variantIndex;
    item.variantType = meta.variantType;
  }

  const clusterTeachingCaps = new Map(
    clusterStates.map((cluster) => [
      cluster.clusterId,
      teachingArcFor(classifyTeachingState({
        exposureCount: cluster.cardsReviewed,
        recallOnExamDay: cluster.mastery,
        confidence: cluster.mastery,
      })).targetItems,
    ]),
  );
  const teachingCapped = enforceConceptTeachingCaps(
    scaffoldPaired,
    (conceptId) => clusterTeachingCaps.get(conceptId) ?? 3,
  );
  const quotaReconciled = [...teachingCapped];
  const quotaKeys = new Set(quotaReconciled.map((item) => `${item.type}:${item.id}`));
  const quotaConceptCounts = new Map<string, number>();
  for (const item of quotaReconciled) {
    quotaConceptCounts.set(
      item.conceptId,
      (quotaConceptCounts.get(item.conceptId) ?? 0) + 1,
    );
  }
  let reconciledFirstSight = quotaReconciled
    .filter((item) => item.firstSightAtSelection).length;
  for (const candidate of clusterQuotaCandidates) {
    if (reconciledFirstSight >= requiredFirstSight) break;
    if (!candidate.firstSightAtSelection) continue;
    const key = `${candidate.type}:${candidate.id}`;
    if (quotaKeys.has(key)) continue;
    const conceptCap = clusterTeachingCaps.get(candidate.conceptId) ?? 3;
    if ((quotaConceptCounts.get(candidate.conceptId) ?? 0) >= conceptCap) continue;
    if (quotaReconciled.length >= size) {
      const replaceAt = quotaReconciled.findLastIndex(
        (item) => !item.firstSightAtSelection,
      );
      if (replaceAt < 0) break;
      const [removed] = quotaReconciled.splice(replaceAt, 1);
      quotaKeys.delete(`${removed.type}:${removed.id}`);
      quotaConceptCounts.set(
        removed.conceptId,
        Math.max(0, (quotaConceptCounts.get(removed.conceptId) ?? 1) - 1),
      );
    }
    quotaReconciled.push(candidate);
    quotaKeys.add(key);
    quotaConceptCounts.set(
      candidate.conceptId,
      (quotaConceptCounts.get(candidate.conceptId) ?? 0) + 1,
    );
    reconciledFirstSight += 1;
  }
  const finalOrdered = breakModalityRuns(quotaReconciled);
  const unseenScaffoldIds = new Set(unseenClusterScaffolds.map((card) => card.id));
  const quotaTaggedItems = finalOrdered.map((item) => ({
    ...item,
    firstSightAtSelection: item.firstSightAtSelection
      ?? unseenScaffoldIds.has(item.id)
      ?? firstSightQuestionIds.has(item.id),
  }));

  const avgPriority =
    quotaTaggedItems.length > 0
      ? quotaTaggedItems.reduce((sum, i) => sum + i.priority, 0) / quotaTaggedItems.length
      : 0;
  const finalCardCount = quotaTaggedItems.filter((item) => item.type === 'card').length;
  const finalQuestionCount = quotaTaggedItems.filter((item) => item.type === 'question').length;
  const selectedFirstSight = quotaTaggedItems.filter((item) => item.firstSightAtSelection).length;

  return {
    items: quotaTaggedItems as UnifiedSessionItem[],
    noveltyQuota: {
      required: requiredFirstSight,
      selected: selectedFirstSight,
    },
    stats: {
      totalConcepts: clusters.length,
      weakConcepts: clusterStates.filter((c) => c.priority > 0).length,
      selectedConcepts: selectedClusterIds.size,
      cardCount: finalCardCount,
      questionCount: finalQuestionCount,
      averagePriority: Math.round(avgPriority * 1000) / 1000,
      conceptPairingRate: computeConceptPairingRate(quotaTaggedItems),
    },
  };
}
