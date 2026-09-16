import { after } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { shuffle } from '@/lib/utils/shuffle';
import { isUsableQuestion } from '@/lib/question-validation';
import type { UnifiedItem, InstantQuestionCandidate } from './unified-session-types';
import { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } from './unified-session-types';
import {
  tierFromComplexity,
  tierFromQuestionDifficulty,
} from '@/lib/audit/walk-metadata';
import { isCardDueForSelection } from '@/lib/knowledge/card-due-eligibility';
import { isBridgeCardEligible } from '@/lib/knowledge/bridge-card-eligibility';

export function parseBatchSize(sizeParam: string | null): number {
  if (!sizeParam) return DEFAULT_BATCH_SIZE;
  const parsed = Number.parseInt(sizeParam, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, MAX_BATCH_SIZE);
}

export function compactMetadata(metadata: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  ) as Prisma.InputJsonValue;
}

export function interleaveGroups(items: UnifiedItem[], groups: UnifiedItem[], gap: number = 5): UnifiedItem[] {
  if (groups.length === 0) return items;
  const result: UnifiedItem[] = [];
  const groupQueue = [...groups];
  let idx = 0;

  while (idx < items.length || groupQueue.length > 0) {
    // Insert one group at the start if we have none yet
    if (result.length === 0 && groupQueue.length > 0) {
      result.push(groupQueue.shift()!);
    }

    // Add up to gap items
    for (let i = 0; i < gap && idx < items.length; i++) {
      result.push(items[idx++]);
    }

    // Insert a group between chunks
    if (groupQueue.length > 0) {
      result.push(groupQueue.shift()!);
    }

    if (idx >= items.length && groupQueue.length > 0 && result.length > 0) {
      // Append any leftover groups at the end
      result.push(...groupQueue.splice(0));
    }
  }

  return result;
}

export function isPreferredInstantQuestion(questionId: string, rotation: string): boolean {
  // Critical care has a curated bank that should be preferred over legacy imports.
  if (rotation === 'critical-care') {
    return questionId.startsWith('bank:critical-care:');
  }
  return true;
}

export function selectInstantQuestionCandidates(
  questions: InstantQuestionCandidate[],
  options: {
    rotation: string;
    weekFilter: number | null;
    clientExcludeQuestionSet: Set<string>;
    globallyExcludedQuestionIds: Set<string>;
  }
): InstantQuestionCandidate[] {
  const usable = questions.filter((question) => {
    if (options.weekFilter !== null && question.week !== options.weekFilter) return false;
    if (options.clientExcludeQuestionSet.has(question.id)) return false;
    if (options.globallyExcludedQuestionIds.has(question.id)) return false;
    return isUsableQuestion(question);
  });

  const preferred = usable.filter((question) =>
    isPreferredInstantQuestion(question.id, options.rotation)
  );
  return preferred.length > 0 ? preferred : usable;
}

export interface CardDueExposureAudit {
  /** Clock used by the final egress due-gate, not the earlier cache-build clock. */
  checkedAt: Date;
  /** Missing means the exact card was pristine; CardProgress.nextDueAt is non-null. */
  nextDueAtByCardId: ReadonlyMap<string, Date>;
  /** Legacy lane markers; bridge cards still require current due/cooldown proof. */
  policyBypassReasonByCardId: ReadonlyMap<string, CardDueEgressPolicyBypassReason>;
  /** A failed lookup leaves ordinary cards and bridges ineligible. */
  lookupFailed: boolean;
  version: 'card-due-egress-v1';
}

export const CARD_DUE_EGRESS_POLICY_BYPASS_REASONS = [
  'failure_escalation',
  'mcq_bridge_card',
] as const;

export type CardDueEgressPolicyBypassReason =
  (typeof CARD_DUE_EGRESS_POLICY_BYPASS_REASONS)[number];

/**
 * Two teaching lanes retain explicit policy markers at final delivery.
 *
 * - failure_escalation: a failed card is intentionally relearned after its
 *   short lane-specific cooldown, before the ordinary SRS clock.
 * - mcq_bridge_card: a prerequisite can precede a harder MCQ only when its
 *   exact due date and 24-hour review cooldown allow it, or it is pristine.
 *   The legacy telemetry marker is not permission to bypass the due clock.
 *
 * Keep this allowlist narrow. New intervention lanes remain due-gated until
 * their pedagogy and telemetry contract is reviewed explicitly.
 */
export function cardDueEgressPolicyBypassReason(
  item: UnifiedItem,
): CardDueEgressPolicyBypassReason | undefined {
  if (item.type !== 'card') return undefined;
  return CARD_DUE_EGRESS_POLICY_BYPASS_REASONS.find(
    (reason) => item.interventionReason === reason,
  );
}

export interface CardDueEgressResult {
  /** Non-cards, eligible due/pristine cards, and explicit failure escalation. */
  items: UnifiedItem[];
  /** Card ids that passed the point-in-time check or an explicit policy bypass. */
  eligibleCardIds: ReadonlySet<string>;
  /** Direct evidence written onto any returned card exposure. */
  audit: CardDueExposureAudit | undefined;
  droppedCardCount: number;
  /** True means the clock read was unavailable and every ordinary card failed closed. */
  lookupFailed: boolean;
}

/**
 * Re-read exact-card clocks at the final delivery boundary.
 *
 * Candidate construction is not enough: static rescue paths and serialized
 * queues can outlive the review that moved a card into the future. Missing
 * CardProgress is the pristine-card case and remains eligible. An unavailable
 * lookup is never interpreted as permission to serve ordinary cards or bridges.
 * Only failure_escalation retains its independent lane-specific permission.
 */
export async function filterCardsAtDueEgress(
  items: UnifiedItem[],
  opts: {
    userId: string;
    rotation: string;
    path: string;
    isGuest: boolean;
    checkedAt?: Date;
  },
): Promise<CardDueEgressResult> {
  const cardIds = [...new Set(
    items
      .filter((item) => item.type === 'card')
      .map((item) => item.id),
  )];
  if (cardIds.length === 0 || opts.isGuest) {
    return {
      items,
      eligibleCardIds: new Set(cardIds),
      audit: undefined,
      droppedCardCount: 0,
      lookupFailed: false,
    };
  }

  const checkedAt = opts.checkedAt ?? new Date();
  const nextDueAtByCardId = new Map<string, Date>();
  const policyBypassReasonByCardId = new Map<
    string,
    CardDueEgressPolicyBypassReason
  >();
  for (const item of items) {
    const reason = cardDueEgressPolicyBypassReason(item);
    if (reason === 'failure_escalation') policyBypassReasonByCardId.set(item.id, reason);
  }
  const policyBypassCardIds = new Set(policyBypassReasonByCardId.keys());
  try {
    const progressRows = await prisma.cardProgress.findMany({
      where: {
        userId: opts.userId,
        cardId: { in: cardIds },
      },
      select: { cardId: true, nextDueAt: true, lastReview: true, status: true },
    });
    for (const row of progressRows) {
      nextDueAtByCardId.set(row.cardId, row.nextDueAt);
    }
    const progressByCardId = new Map(progressRows.map(row => [row.cardId, row]));
    const eligibleCardIds = new Set(policyBypassCardIds);
    const allowedBypasses = new Map(policyBypassReasonByCardId);
    for (const item of items) {
      if (item.type !== 'card') continue;
      if (cardDueEgressPolicyBypassReason(item) === 'mcq_bridge_card') {
        if (isBridgeCardEligible(progressByCardId.get(item.id), checkedAt)) {
          eligibleCardIds.add(item.id);
          allowedBypasses.set(item.id, 'mcq_bridge_card');
        }
      } else if (isCardDueForSelection(nextDueAtByCardId.get(item.id), checkedAt)) {
        eligibleCardIds.add(item.id);
      }
    }
    return {
      items: items.filter(
        (item) => item.type !== 'card' || eligibleCardIds.has(item.id),
      ),
      eligibleCardIds,
      audit: {
        checkedAt,
        nextDueAtByCardId,
        policyBypassReasonByCardId: allowedBypasses,
        lookupFailed: false,
        version: 'card-due-egress-v1',
      },
      droppedCardCount: cardIds.length - eligibleCardIds.size,
      lookupFailed: false,
    };
  } catch (error) {
    logger.error(`${opts.path}: final card due lookup failed; dropping ordinary cards and bridges`, {
      userId: opts.userId,
      rotation: opts.rotation,
      candidateCardCount: cardIds.length,
      policyBypassCardCount: policyBypassCardIds.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      items: items.filter(
        (item) => item.type !== 'card' || policyBypassCardIds.has(item.id),
      ),
      eligibleCardIds: policyBypassCardIds,
      audit: {
        checkedAt,
        nextDueAtByCardId,
        policyBypassReasonByCardId,
        lookupFailed: true,
        version: 'card-due-egress-v1',
      },
      droppedCardCount: cardIds.length - policyBypassCardIds.size,
      lookupFailed: true,
    };
  }
}

/** Log content_exposed events in the background for a batch of items. */
export function logExposures(
  items: UnifiedItem[],
  opts: {
    userId: string;
    rotation: string;
    queueType: string;
    batchId: string;
    sessionId: string;
    anonymousSessionId?: string;
    feedMode?: 'new-only' | 'mixed';
    cardDueAudit?: CardDueExposureAudit;
  },
) {
  if (items.length === 0) return;
  const events = items.map((item, index) => ({
    userId: opts.userId,
    eventType: 'content_exposed',
    sourceType: item.type,
    sourceId: item.id,
    conceptIds: item.conceptId ? [item.conceptId] : [],
    rotation: opts.rotation,
    week: item.week ?? null,
    metadata: compactMetadata({
      queueReason: item.interventionReason ?? opts.queueType,
      queueType: opts.queueType,
      priority: item.priority,
      position: index,
      batchSize: items.length,
      batchId: opts.batchId,
      sessionId: opts.sessionId,
      // Exact exposure→decision linkage for future causal audits. Session/item
      // heuristics cannot reliably distinguish a live selection from a cached
      // decision that was built before the learner's preceding answer.
      serveDecisionId: item.serveDecisionId,
      itemType: item.type,
      conceptName: item.conceptName,
      anonymousSessionId: opts.anonymousSessionId,
      // Walk decision context (Phase 1 of scheduler-walk-audit)
      servedBy: item.servedBy,
      clusterId: item.clusterId,
      predictedRecall: item.predictedRecall,
      conditioning: item.conditioning,
      predictedRecallModel: item.predictedRecallModel,
      predictedRecallSource: item.predictedRecallSource,
      predictedRecallStatus: item.predictedRecallStatus,
      difficultyTier:
        item.servedBy === undefined
          ? undefined
          : item.difficultyTier
            ?? (item.type === 'question'
              ? tierFromQuestionDifficulty(item.difficulty)
              : tierFromComplexity(item.complexity)),
      challengePolicyVersion:
        item.servedBy === undefined ? undefined : item.challengePolicyVersion,
      challengeTargetTier:
        item.servedBy === undefined ? undefined : item.challengeTargetTier,
      challengeDistance:
        item.servedBy === undefined ? undefined : item.challengeDistance,
      challengePolicyApplied:
        item.servedBy === undefined ? undefined : item.challengePolicyApplied,
      noveltyPolicyVersion:
        item.servedBy === undefined ? undefined : item.noveltyPolicyVersion,
      recentNeighborSimilarity:
        item.servedBy === undefined ? undefined : item.recentNeighborSimilarity,
      noveltyPenalty:
        item.servedBy === undefined ? undefined : item.noveltyPenalty,
      conceptThreadPolicyVersion:
        item.servedBy === undefined ? undefined : item.conceptThreadPolicyVersion,
      conceptThreadPolicyApplied:
        item.servedBy === undefined ? undefined : item.conceptThreadPolicyApplied,
      conceptThreadAnchorEventId:
        item.servedBy === undefined ? undefined : item.conceptThreadAnchorEventId,
      conceptThreadAnchorItemId:
        item.servedBy === undefined ? undefined : item.conceptThreadAnchorItemId,
      conceptThreadAnchorFacet:
        item.servedBy === undefined ? undefined : item.conceptThreadAnchorFacet,
      conceptThreadTargetFacet:
        item.servedBy === undefined ? undefined : item.conceptThreadTargetFacet,
      conceptThreadSharedTopic:
        item.servedBy === undefined ? undefined : item.conceptThreadSharedTopic,
      conceptThreadAgeMs:
        item.servedBy === undefined ? undefined : item.conceptThreadAgeMs,
      conceptThreadInterveningExposures:
        item.servedBy === undefined
          ? undefined
          : item.conceptThreadInterveningExposures,
      poolSize: item.poolSize,
      positionInSession: item.servedBy !== undefined ? (item.positionInSession ?? index) : undefined,
      similarityToPrior: item.similarityToPrior,
      // Feed-mode tag lets walk-audit suppress pool-constrained pathologies
      // for new-only sessions. See @/lib/audit/walk-pathologies.
      feedMode: opts.feedMode ?? 'mixed',
      // Cloze-variant group id lets walk-audit detect `variant-sibling-repeat`
      // (a regression in scheduler suppression). See @/lib/audit/walk-pathologies.
      variantGroupId: item.variantGroupId,
      // Exact-card SRS proof at the last automatic-feed egress boundary. It is
      // intentionally absent on explicit override paths; per-queue coverage is
      // part of the morning-check verdict.
      srsDueGateVersion:
        item.type === 'card' ? opts.cardDueAudit?.version : undefined,
      srsDueGateBypassReason:
        item.type === 'card'
          ? opts.cardDueAudit?.policyBypassReasonByCardId.get(item.id)
          : undefined,
      srsDueGateLookupFailed:
        item.type === 'card' ? opts.cardDueAudit?.lookupFailed : undefined,
      srsEligibilityCheckedAt:
        item.type === 'card' ? opts.cardDueAudit?.checkedAt.toISOString() : undefined,
      srsProgressFound:
        item.type === 'card' && opts.cardDueAudit && !opts.cardDueAudit.lookupFailed
          ? opts.cardDueAudit.nextDueAtByCardId.has(item.id)
          : undefined,
      srsNextDueAtAtOffer:
        item.type === 'card' && opts.cardDueAudit && !opts.cardDueAudit.lookupFailed
          ? opts.cardDueAudit.nextDueAtByCardId.get(item.id)?.toISOString() ?? null
          : undefined,
    }),
  }));
  after(async () => {
    try {
      await prisma.learningEvent.createMany({ data: events });
    } catch (err) {
      logger.error('Failed to log exposures', { userId: opts.userId, rotation: opts.rotation, queueType: opts.queueType, error: String(err) });
    }
  });
}

const GROUP_SELECT = {
  id: true,
  type: true,
  contextImageUrl: true,
  contextText: true,
  steps: true,
  difficulty: true,
  topics: true,
  rotation: true,
  week: true,
  diagnosisSummary: true,
} as const;

/**
 * Fetch question group items in parallel. Extracted so the queries can
 * start before the scheduler completes.
 */
export async function fetchGroupItems(
  rotation: string,
  weekFilter: number | null,
  enabledGroupTypes: string[],
  excludedGroupIds: Set<string>,
): Promise<UnifiedItem[]> {
  if (enabledGroupTypes.length === 0) return [];

  const includesEcg = enabledGroupTypes.includes('ecg');
  const otherGroupTypes = enabledGroupTypes.filter((t) => t !== 'ecg');

  const [ecgGroups, otherGroups, universalGroups] = await Promise.all([
    includesEcg
      ? prisma.questionGroup.findMany({
          where: {
            rotation,
            type: 'ecg',
            ...(weekFilter !== null ? { week: weekFilter } : {}),
          },
          select: GROUP_SELECT,
          take: 5,
          orderBy: { totalAttempts: 'asc' },
        })
      : Promise.resolve([]),
    otherGroupTypes.length > 0
      ? prisma.questionGroup.findMany({
          where: {
            rotation,
            type: { in: otherGroupTypes },
            ...(weekFilter !== null ? { week: weekFilter } : {}),
          },
          select: GROUP_SELECT,
          take: 3,
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve([]),
    // Only serve groups matching the requested rotation (or untagged).
    // Previously this pulled cross-rotation groups, but since all groups
    // are currently CC, it leaked CC content into PAAM/CAH/PWH sessions.
    prisma.questionGroup.findMany({
      where: {
        type: { in: enabledGroupTypes },
        rotation: null,
      },
      select: GROUP_SELECT,
      take: 5,
      orderBy: { totalAttempts: 'asc' },
    }),
  ]);

  const rotationGroups = [...ecgGroups, ...otherGroups].filter((g) => !excludedGroupIds.has(g.id));
  const universal = universalGroups.filter((g) => !excludedGroupIds.has(g.id));

  const shuffledGroups = shuffle([...rotationGroups, ...universal]).slice(0, 4);
  return shuffledGroups.map((group): UnifiedItem => ({
    type: 'group' as const,
    id: group.id,
    groupType: group.type,
    contextImageUrl: group.contextImageUrl ?? null,
    contextText: group.contextText ?? null,
    steps: (group.steps as unknown[] | null) ?? undefined,
    diagnosisSummary: group.diagnosisSummary ?? null,
    difficulty: group.difficulty,
    topics: group.topics,
    rotation: group.rotation || rotation,
    week: group.week ?? null,
    priority: 2,
  }));
}

/**
 * Ease-in ordering for cold-start batches: stable sort easy → hard so a
 * brand-new user's first items are scaffolding, not a 500-char hard ethics
 * vignette (a real first-session experience, 2026-08-19). Cards tier by
 * complexity, questions by difficulty; unlabelled items sit in the middle.
 * Within a tier the incoming (pre-shuffled) order is preserved, so variety
 * survives — only the ramp is imposed.
 */
export function orderEaseIn(items: UnifiedItem[]): UnifiedItem[] {
  const tier = (item: UnifiedItem): number => {
    if (item.type === 'question') {
      if (item.difficulty === 'easy') return 1;
      if (item.difficulty === 'hard') return 3;
      return 2;
    }
    const complexity = item.complexity;
    if (complexity == null) return 2;
    if (complexity <= 1) return 1;
    if (complexity === 2) return 2;
    return 3;
  };
  return items
    .map((item, index) => ({ item, index, tier: tier(item) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.item);
}

/**
 * Pick at most `limit` cards, at most one per variant group, preferring a
 * sibling the learner has never been served.
 *
 * The instant lane previously shuffled and took the first sibling of each
 * group. That rotates by chance, so with three siblings an already-seen one is
 * re-drawn about a third of the time — which is what "I keep seeing the same
 * card" feels like from the inside. Choosing the unseen sibling makes rotation
 * deliberate.
 *
 * Group *position* is preserved: this changes WHICH card of a group is served,
 * never where the group sits in the batch. Otherwise variant rotation would
 * quietly become a ranking change.
 *
 * `seenCardIds` is a bounded point lookup supplied by the caller, never a
 * history aggregation — see .claude/rules/hot-path-latency.md.
 */
export function selectRotatingVariants<T extends { id: string; variantGroupId: string | null }>(
  shuffled: T[],
  seenCardIds: ReadonlySet<string>,
  limit: number,
): T[] {
  // Best sibling per group: the first unseen one in shuffle order, else the
  // first seen one so a fully-reviewed group still contributes.
  const chosenForGroup = new Map<string, T>();
  for (const card of shuffled) {
    if (card.variantGroupId == null) continue;
    const current = chosenForGroup.get(card.variantGroupId);
    if (current === undefined) {
      chosenForGroup.set(card.variantGroupId, card);
      continue;
    }
    if (seenCardIds.has(current.id) && !seenCardIds.has(card.id)) {
      chosenForGroup.set(card.variantGroupId, card);
    }
  }

  const emittedGroups = new Set<string>();
  const out: T[] = [];
  for (const card of shuffled) {
    if (out.length >= limit) break;
    const group = card.variantGroupId;
    if (group == null) {
      out.push(card);
      continue;
    }
    if (emittedGroups.has(group)) continue;
    emittedGroups.add(group);
    out.push(chosenForGroup.get(group) ?? card);
  }
  return out;
}
