/**
 * Unified scheduler: candidate queries
 *
 * The database reads behind the cluster fallback and the rotation-bank
 * question top-up. Moved out of unified-scheduler.ts unchanged.
 */

import { prisma } from '@/lib/prisma';
import { getExcludedQuestionIds } from '@/lib/question-bank';
import { withDefaultQuestionServingPolicy } from '@/lib/questions/source-policy';
import { userIdCanAccessPrivateSources } from '@/lib/questions/private-access';
import { withoutRawPublicUsmleQuestions } from '@/lib/usmle/raw-question-boundary';
import { sessionCandidateItemWhere } from '@/lib/knowledge/session-candidate-scope';
import { imagePromptCardWhere, clipPromptCardWhere } from '@/lib/study/servable-pool';
import { selectVariantAwareQuestions } from '@/lib/question-variants';
import { EXCLUDED_TOPICS } from './bulk-candidates';
import { practiceLocaleWhere } from '@/lib/study/practice-locale';
import { questionSuppressionKey } from './variant-suppression';
import {
  admitMasteredWithinBudget,
  countMastered,
  resolveRetirementPolicy,
  type QuestionFamiliarity,
  type ReentryCounter,
} from './question-retirement';
import type { CardCandidate } from './candidate-ranking';
import {
  findManyCards,
  ownerPrivateOrSharedCardScope,
  scopedCardProgressWhere,
} from '@/lib/cards/read-repository.server';
import { cardDueForSelectionWhere } from '@/lib/knowledge/card-due-eligibility';
import type { UnifiedSessionSelectionDeterminism } from './unified-scheduler-types';
import { shuffleForSelection } from './unified-scheduler-config';

// =============================================================================
// Helper Functions
// =============================================================================



export async function getCardsForCluster(
  userId: string,
  rotation: string,
  clusterId: string,
  maxCandidates: number,
  options: {
    selectedCardIds: Set<string>;
    minComplexity?: number;
    now?: Date;
    selectionDeterminism?: UnifiedSessionSelectionDeterminism;
    practiceLocale?: 'au' | 'us';
    crossSourceRotations?: readonly string[];
    crossSourceMappingMode?: 'adjacent' | 'open';
    isCopyrightTier?: boolean;
  },
): Promise<Array<CardCandidate & { firstSightAtSelection: boolean }>> {
  const excludedIds = options.selectedCardIds.size > 0 ? [...options.selectedCardIds] : undefined;
  // Same topics gate every other read path applies — without it the cluster
  // fallback can serve _needs-image / _incomplete-data cards.
  const excludedTopicsNot = { topics: { hasSome: [...EXCLUDED_TOPICS] } };
  const locale = options.practiceLocale ?? 'au';
  const localeWhere = practiceLocaleWhere(locale);
  const selectionNow = options.now ?? new Date();
  // Prompt-media gates, the same ones the concept path applies in
  // bulkFetchCandidates. They live in the AND arm because each returns its own
  // `OR` key, which would clobber the rotation scope's `OR` if spread alongside.
  const tierGates = [
    imagePromptCardWhere(options.isCopyrightTier === true),
    clipPromptCardWhere(options.isCopyrightTier === true),
  ].filter((gate) => Object.keys(gate).length > 0);

  const [newCards, weakCards] = await Promise.all([
    findManyCards(ownerPrivateOrSharedCardScope(userId), {
      where: {
        // The same scope the concept path uses, so a card a companion corpus
        // declared for this view is reachable here too. Rotation equality alone
        // serves nothing at all for a view rotation that owns no cards.
        ...sessionCandidateItemWhere(
          rotation,
          options.crossSourceRotations ?? [],
          options.crossSourceMappingMode ?? 'adjacent',
        ),
        clusterId,
        deletedAt: null,
        shelvedAt: null,
        AND: [localeWhere, ...tierGates],
        ...(excludedIds ? { id: { notIn: excludedIds } } : {}),
        ...(options.minComplexity != null
          ? { complexity: { gte: options.minComplexity } }
          : {}),
        progress: { none: { userId } },
        NOT: excludedTopicsNot,
      },
      select: {
        id: true,
        clusterId: true,
        similarCards: true,
        topics: true,
        sourceFile: true,
        importance: true,
        complexity: true,
        variantGroupId: true,
        variantIndex: true,
        variantType: true,
      },
      orderBy: { complexity: 'asc' },
      take: maxCandidates,
    }),
    prisma.cardProgress.findMany({
      where: scopedCardProgressWhere(
        ownerPrivateOrSharedCardScope(userId),
        {
          userId,
          suppressed: false,
          flagged: false,
          status: { notIn: ['retired'] },
          ...cardDueForSelectionWhere(selectionNow),
        },
        {
          ...sessionCandidateItemWhere(
            rotation,
            options.crossSourceRotations ?? [],
            options.crossSourceMappingMode ?? 'adjacent',
          ),
          clusterId,
          deletedAt: null,
          shelvedAt: null,
          AND: [localeWhere, ...tierGates],
          ...(excludedIds ? { id: { notIn: excludedIds } } : {}),
          ...(options.minComplexity != null
            ? { complexity: { gte: options.minComplexity } }
            : {}),
          NOT: excludedTopicsNot,
        },
      ),
      orderBy: [{ retrievalStrength: 'asc' }],
      select: {
        card: {
          select: {
            id: true,
            clusterId: true,
            similarCards: true,
            topics: true,
            sourceFile: true,
            importance: true,
            complexity: true,
            variantGroupId: true,
            variantIndex: true,
            variantType: true,
          },
        },
      },
      take: maxCandidates,
    }),
  ]);

  const combined = [
    ...shuffleForSelection(
      newCards,
      options.selectionDeterminism,
      `cluster-card\0${clusterId}\0new`,
    ),
    ...shuffleForSelection(
      weakCards.map((row) => row.card),
      options.selectionDeterminism,
      `cluster-card\0${clusterId}\0weak`,
    ),
  ];
  const firstSightCardIds = new Set(newCards.map((card) => card.id));
  const seen = new Set<string>();
  const selected: Array<CardCandidate & { firstSightAtSelection: boolean }> = [];

  for (const card of combined) {
    if (selected.length >= maxCandidates) break;
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    if (options.selectedCardIds.has(card.id)) continue;
    selected.push({
      id: card.id,
      clusterId: card.clusterId,
      similarCards: card.similarCards,
      topics: card.topics,
      sourceFile: card.sourceFile,
      importance: card.importance,
      complexity: card.complexity,
      variantGroupId: card.variantGroupId,
      variantIndex: card.variantIndex,
      variantType: card.variantType,
      firstSightAtSelection: firstSightCardIds.has(card.id),
    });
  }

  return selected;
}

export async function getUnseenScaffoldsForClusters(
  userId: string,
  rotation: string,
  clusterIds: string[],
  selectedCardIds: Set<string>,
): Promise<CardCandidate[]> {
  if (clusterIds.length === 0) return [];

  const excludedIds = selectedCardIds.size > 0 ? [...selectedCardIds] : undefined;
  return findManyCards(ownerPrivateOrSharedCardScope(userId), {
    where: {
      rotation,
      clusterId: { in: clusterIds },
      complexity: 1,
      deletedAt: null,
      shelvedAt: null,
      ...(excludedIds ? { id: { notIn: excludedIds } } : {}),
      progress: { none: { userId } },
      NOT: { topics: { hasSome: [...EXCLUDED_TOPICS] } },
    },
    select: {
      id: true,
      clusterId: true,
      similarCards: true,
      topics: true,
      sourceFile: true,
      importance: true,
      complexity: true,
      variantGroupId: true,
      variantIndex: true,
      variantType: true,
    },
    orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function getQuestionsForRotation(
  userId: string,
  rotation: string,
  limit: number,
  options: {
    selectedQuestionIds: Set<string>;
    selectedQuestionVariantGroups?: Set<string>;
    /**
     * Per-user question exposure. Supply it (with the counter) or this lane will
     * draw mastered and never-seen questions with equal probability — see below.
     */
    questionFamiliarity?: Map<string, QuestionFamiliarity>;
    masteredReentryCounter?: ReentryCounter;
    /** Server-authorized source partitions for composed rotations only. */
    crossSourceRotations?: readonly string[];
    crossSourceMappingMode?: 'adjacent' | 'open';
    selectionDeterminism?: UnifiedSessionSelectionDeterminism;
  }
): Promise<Array<{
  id: string;
  rotation: string;
  topics: string[];
  variantGroupId: string | null;
  variantType: string | null;
}>> {
  if (limit <= 0) return [];

  const excludedIds = options.selectedQuestionIds.size > 0 ? [...options.selectedQuestionIds] : [];
  const globallyExcluded = await getExcludedQuestionIds();
  if (globallyExcluded.size > 0) {
    excludedIds.push(...globallyExcluded);
  }
  const poolSize = Math.max(30, limit * 10);

  const allowPrivateSources = await userIdCanAccessPrivateSources(userId);
  const candidates = await prisma.question.findMany({
    where: withDefaultQuestionServingPolicy(
      withoutRawPublicUsmleQuestions({
        ...sessionCandidateItemWhere(
          rotation,
          options.crossSourceRotations ?? [],
          options.crossSourceMappingMode ?? 'adjacent',
        ),
        contentState: { not: 'shelved' },
        ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
        NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
      }),
      { allowPrivateSources }
    ),
    select: {
      id: true,
      rotation: true,
      topics: true,
      variantGroupId: true,
      variantType: true,
      difficulty: true,
      facilityIndex: true,
      totalAttempts: true,
      source: true,
    },
    take: poolSize,
    orderBy: { createdAt: 'desc' },
  });

  const candidatesAfterSessionVariantFilter = options.selectedQuestionVariantGroups
    ? candidates.filter((q) => {
        const key = questionSuppressionKey(q);
        return !key || !options.selectedQuestionVariantGroups!.has(key);
      })
    : candidates;

  // Gate mastered questions BEFORE selection. selectVariantAwareQuestions is
  // never-answered-first only WITHIN a variant group: solo questions are keyed
  // `__single:${id}` (question-variants.ts:55) so that filter is vacuous for them,
  // and the cross-group pick is `shuffle(selected)` (:97). So it is NOT
  // freshness-first across the pool — an earlier comment here claimed it was, and
  // that was the stated basis for leaving this lane ungated. With mastery no longer
  // excluded upstream, that would draw mastered and fresh with equal probability and,
  // once fresh candidates run out, hand back a whole session of mastered questions —
  // the flood the cap exists to prevent.
  const familiarity = options.questionFamiliarity;
  const counter = options.masteredReentryCounter;
  const admitted = familiarity && counter
    ? admitMasteredWithinBudget(
        candidatesAfterSessionVariantFilter,
        (q) => q.id,
        familiarity,
        limit,
        resolveRetirementPolicy(),
        counter,
      )
    : candidatesAfterSessionVariantFilter;

  const selected = options.selectionDeterminism
    ? await selectVariantAwareQuestions(
        admitted,
        userId,
        limit,
        48,
        familiarity,
        options.selectionDeterminism,
      )
    : await selectVariantAwareQuestions(
        admitted,
        userId,
        limit,
        48,
        familiarity,
      );
  if (familiarity && counter) {
    // Increment on what was actually SERVED, not what was admitted.
    counter.masteredServed += countMastered(selected, (q) => q.id, familiarity);
  }
  for (const q of selected) {
    options.selectedQuestionIds.add(q.id);
    const key = questionSuppressionKey(q);
    if (key) options.selectedQuestionVariantGroups?.add(key);
  }

  return selected.map((q) => ({
    id: q.id,
    rotation: q.rotation,
    topics: q.topics,
    variantGroupId: q.variantGroupId,
    variantType: q.variantType,
  }));
}
